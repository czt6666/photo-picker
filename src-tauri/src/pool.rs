//! 带优先级的图片处理线程池（缩略图、预览图都走它）。
//!
//! 为什么不用普通线程池？因为选片时“先做哪张”比“做得多快”更重要：
//!
//! - **Urgent**：看图器里当前正在看的那张。用户盯着屏幕等它，插到最前面。
//! - **High**：网格里当前可见的缩略图、看图器预加载的相邻照片。用**后进先出（栈）**：
//!   用户飞快滚动网格时，最新滚进视野的那一屏最先出图，滚过去的那些往后排。
//!   普通先进先出队列在这里会出现“滚到底了，还在一张张生成顶部早已看不到的图”。
//! - **Low**：打开文件夹后在后台把整个文件夹的缩略图预先生成好。只在没有更急的活时才做。
//!   切换文件夹时整个 Low 队列被替换，不会为已经离开的文件夹白干活。
//!
//! 同一个 key（同一张图的同一种尺寸）同时被请求多次时只算一次，结果分发给所有等待者。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    Urgent,
    High,
    Low,
}

pub type Bytes = Arc<Vec<u8>>;
pub type JobResult = Result<Bytes, String>;
pub type Work = Box<dyn FnOnce() -> JobResult + Send>;
pub type Callback = Box<dyn FnOnce(JobResult) + Send>;
pub type ProgressFn = Box<dyn Fn(usize, usize) + Send + Sync>;

struct Job {
    key: String,
    prio: Priority,
    work: Work,
}

#[derive(Default)]
struct State {
    urgent: Vec<Job>,
    high: Vec<Job>,
    low: VecDeque<Job>,
    running: HashSet<String>,
    waiters: HashMap<String, Vec<Callback>>,
    low_total: usize,
    low_done: usize,
}

impl State {
    fn pop(&mut self) -> Option<Job> {
        self.urgent.pop().or_else(|| self.high.pop()).or_else(|| self.low.pop_front())
    }
}

struct Inner {
    state: Mutex<State>,
    cv: Condvar,
    progress: Mutex<Option<ProgressFn>>,
    last_progress: Mutex<Instant>,
}

#[derive(Clone)]
pub struct Pool {
    inner: Arc<Inner>,
}

impl Pool {
    pub fn new(threads: usize) -> Self {
        let inner = Arc::new(Inner {
            state: Mutex::new(State::default()),
            cv: Condvar::new(),
            progress: Mutex::new(None),
            last_progress: Mutex::new(Instant::now()),
        });
        for i in 0..threads.max(1) {
            let inner = inner.clone();
            thread::Builder::new()
                .name(format!("img-worker-{i}"))
                .spawn(move || worker(inner))
                .expect("spawn worker");
        }
        Pool { inner }
    }

    /// 线程数：留一个核给界面和 webview 解码。
    pub fn default_threads() -> usize {
        let n = thread::available_parallelism().map_or(4, |n| n.get());
        n.saturating_sub(1).clamp(2, 8)
    }

    pub fn set_progress(&self, f: ProgressFn) {
        *self.inner.progress.lock() = Some(f);
    }

    /// 提交任务。同 key 已在执行时只登记回调，不重复执行。
    pub fn submit(&self, key: String, prio: Priority, work: Work, cb: Option<Callback>) {
        let mut st = self.inner.state.lock();
        if let Some(cb) = cb {
            st.waiters.entry(key.clone()).or_default().push(cb);
        }
        if st.running.contains(&key) {
            return;
        }
        let job = Job { key, prio, work };
        match prio {
            Priority::Urgent => st.urgent.push(job),
            Priority::High => st.high.push(job),
            Priority::Low => st.low.push_back(job),
        }
        drop(st);
        self.inner.cv.notify_one();
    }

    /// 用新的一批后台任务替换整个 Low 队列（切换文件夹时调用）。
    pub fn replace_low(&self, jobs: Vec<(String, Work)>) {
        let mut st = self.inner.state.lock();
        st.low.clear();
        st.low_total = jobs.len();
        st.low_done = 0;
        st.low.extend(jobs.into_iter().map(|(key, work)| Job { key, prio: Priority::Low, work }));
        drop(st);
        self.inner.cv.notify_all();
        self.report_progress(true);
    }

    fn report_progress(&self, force: bool) {
        report_progress(&self.inner, force);
    }
}

fn report_progress(inner: &Inner, force: bool) {
    let (done, total) = {
        let st = inner.state.lock();
        (st.low_done, st.low_total)
    };
    let finished = done >= total;
    {
        let mut last = inner.last_progress.lock();
        // 限流：最多每 200ms 报一次，开始和结束时必报
        if !force && !finished && last.elapsed() < Duration::from_millis(200) {
            return;
        }
        *last = Instant::now();
    }
    if let Some(f) = inner.progress.lock().as_ref() {
        f(done, total);
    }
}

fn worker(inner: Arc<Inner>) {
    loop {
        let job = {
            let mut st = inner.state.lock();
            loop {
                match st.pop() {
                    Some(job) if st.running.contains(&job.key) => {
                        // 同一张图已在别的线程上做；等待者会由那边统一通知
                        if job.prio == Priority::Low {
                            st.low_done += 1;
                        }
                        continue;
                    }
                    Some(job) => {
                        st.running.insert(job.key.clone());
                        break job;
                    }
                    None => inner.cv.wait(&mut st),
                }
            }
        };
        let key = job.key.clone();
        let prio = job.prio;
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job.work))
            .unwrap_or_else(|_| Err("解码时发生内部错误".to_string()));
        let callbacks = {
            let mut st = inner.state.lock();
            st.running.remove(&key);
            if prio == Priority::Low {
                st.low_done += 1;
            }
            st.waiters.remove(&key).unwrap_or_default()
        };
        for cb in callbacks {
            cb(result.clone());
        }
        if prio == Priority::Low {
            report_progress(&inner, false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;

    fn ok(v: u8) -> JobResult {
        Ok(Arc::new(vec![v]))
    }

    #[test]
    fn dedups_concurrent_requests_for_same_key() {
        let pool = Pool::new(2);
        let runs = Arc::new(AtomicUsize::new(0));
        let (tx, rx) = mpsc::channel();
        for _ in 0..5 {
            let runs = runs.clone();
            let tx = tx.clone();
            pool.submit(
                "same".into(),
                Priority::High,
                Box::new(move || {
                    runs.fetch_add(1, Ordering::SeqCst);
                    thread::sleep(Duration::from_millis(50));
                    ok(7)
                }),
                Some(Box::new(move |r| tx.send(r.unwrap()[0]).unwrap())),
            );
        }
        for _ in 0..5 {
            assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 7);
        }
        // 第一个执行时其余 4 个只是登记等待；最多再有一个“漏网”重复执行（入队早于执行开始）
        assert!(runs.load(Ordering::SeqCst) <= 2, "runs = {}", runs.load(Ordering::SeqCst));
    }

    #[test]
    fn high_is_lifo_and_beats_low() {
        let pool = Pool::new(1);
        let order = Arc::new(Mutex::new(Vec::new()));
        // 先用一个慢任务占住唯一的线程，再排队
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        pool.submit("block".into(), Priority::High, Box::new(move || { gate_rx.recv().unwrap(); ok(0) }), None);
        thread::sleep(Duration::from_millis(30));
        let (done_tx, done_rx) = mpsc::channel();
        let mk = |name: &'static str| -> Work {
            let order = order.clone();
            Box::new(move || {
                order.lock().push(name);
                ok(1)
            })
        };
        pool.replace_low(vec![("l1".into(), mk("l1")), ("l2".into(), mk("l2"))]);
        pool.submit("h1".into(), Priority::High, mk("h1"), None);
        pool.submit("h2".into(), Priority::High, mk("h2"), None);
        pool.submit("u".into(), Priority::Urgent, mk("u"), None);
        pool.submit("end".into(), Priority::Low, Box::new(|| ok(9)), Some(Box::new(move |_| done_tx.send(()).unwrap())));
        gate_tx.send(()).unwrap();
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(*order.lock(), vec!["u", "h2", "h1", "l1", "l2"]);
    }

    #[test]
    fn panic_in_job_reports_error_instead_of_killing_worker() {
        let pool = Pool::new(1);
        let (tx, rx) = mpsc::channel();
        let tx2 = tx.clone();
        pool.submit("p".into(), Priority::High, Box::new(|| panic!("boom")), Some(Box::new(move |r| tx.send(r.is_err()).unwrap())));
        pool.submit("q".into(), Priority::High, Box::new(|| ok(1)), Some(Box::new(move |r| tx2.send(r.is_err()).unwrap())));
        let mut got = vec![rx.recv_timeout(Duration::from_secs(2)).unwrap(), rx.recv_timeout(Duration::from_secs(2)).unwrap()];
        got.sort();
        assert_eq!(got, vec![false, true]);
    }
}
