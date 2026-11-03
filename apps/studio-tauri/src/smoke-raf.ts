// Test builds only. requestAnimationFrame doesn't fire in the hidden test window, so a message loop
// stands in for it. This exercises the real play path; it says nothing about display.
const queue = new Map<number, FrameRequestCallback>();
let id = 0;
window.requestAnimationFrame = (cb) => {
  queue.set(++id, cb);
  return id;
};
window.cancelAnimationFrame = (h) => {
  queue.delete(h);
};
const mc = new MessageChannel();
let next = performance.now();
mc.port1.onmessage = () => {
  const now = performance.now();
  if (now >= next) {
    next = now + 1000 / 60;
    const due = [...queue.values()];
    queue.clear();
    for (const cb of due) cb(now);
  }
  mc.port2.postMessage(0);
};
mc.port2.postMessage(0);
export {};
