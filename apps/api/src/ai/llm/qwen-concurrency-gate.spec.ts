import { QwenConcurrencyGate } from './qwen-concurrency-gate';

/** Small helper: resolves on the next microtask/macrotask tick so queued acquire() promises that
 *  are already settled get a chance to run before an assertion checks them. */
function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('QwenConcurrencyGate', () => {
  it('grants an immediate acquire when nothing else holds the gate', async () => {
    const gate = new QwenConcurrencyGate();
    const release = await gate.acquire('high');
    expect(typeof release).toBe('function');
    release();
  });

  it('queues a second acquire until the first releases', async () => {
    const gate = new QwenConcurrencyGate();
    const release1 = await gate.acquire('high');

    let secondAcquired = false;
    const second = gate.acquire('high').then((release2) => {
      secondAcquired = true;
      release2();
    });

    await tick();
    expect(secondAcquired).toBe(false); // still held by the first caller

    release1();
    await second;
    expect(secondAcquired).toBe(true);
  });

  it('serves a waiting high-priority request before a waiting low-priority one, regardless of arrival order', async () => {
    const gate = new QwenConcurrencyGate();
    const release0 = await gate.acquire('high'); // occupy the gate first

    const order: string[] = [];
    const low = gate.acquire('low').then((release) => {
      order.push('low');
      release();
    });
    await tick();
    const high = gate.acquire('high').then((release) => {
      order.push('high');
      release();
    });
    await tick();

    release0(); // both are now waiting; high arrived AFTER low but must still win
    await Promise.all([low, high]);
    expect(order).toEqual(['high', 'low']);
  });

  it('never blocks the gate idle when only low-priority work is waiting', async () => {
    const gate = new QwenConcurrencyGate();
    const release0 = await gate.acquire('high');
    const order: string[] = [];
    const low = gate.acquire('low').then((release) => {
      order.push('low');
      release();
    });
    release0();
    await low;
    expect(order).toEqual(['low']); // served immediately, no artificial delay
  });

  it('preserves FIFO order among waiters of the same priority', async () => {
    const gate = new QwenConcurrencyGate();
    const release0 = await gate.acquire('high');
    const order: number[] = [];
    const waiters = [1, 2, 3].map((n) =>
      gate.acquire('high').then((release) => {
        order.push(n);
        release();
      }),
    );
    // ensure enqueue order matches array order before releasing
    await tick();
    release0();
    await Promise.all(waiters);
    expect(order).toEqual([1, 2, 3]);
  });

  it('promotes a starved low-priority waiter ahead of a continuous stream of high-priority arrivals', async () => {
    const gate = new QwenConcurrencyGate();
    const nowSpy = jest.spyOn(Date, 'now');
    let simulatedNow = 1_000_000;
    nowSpy.mockImplementation(() => simulatedNow);

    const release0 = await gate.acquire('high');
    const order: string[] = [];
    const low = gate.acquire('low').then((release) => {
      order.push('low');
      release();
    });
    await tick();

    // Advance the clock past the starvation threshold before the next high-priority arrival.
    simulatedNow += 6000;
    const high = gate.acquire('high').then((release) => {
      order.push('high');
      release();
    });
    await tick();

    release0();
    await Promise.all([low, high]);
    expect(order).toEqual(['low', 'high']); // starved low-priority waiter went first

    nowSpy.mockRestore();
  });

  it('removes a waiter and rejects its acquire() when its signal aborts while still queued', async () => {
    const gate = new QwenConcurrencyGate();
    const release0 = await gate.acquire('high');
    const controller = new AbortController();

    const queued = gate.acquire('low', controller.signal);
    await tick();
    controller.abort();

    await expect(queued).rejects.toThrow(/Aborted/);

    // The gate must still work normally afterwards — the aborted waiter shouldn't leave it stuck.
    const order: string[] = [];
    const next = gate.acquire('high').then((release) => {
      order.push('next');
      release();
    });
    release0();
    await next;
    expect(order).toEqual(['next']);
  });

  it('rejects immediately if the signal is already aborted before acquiring', async () => {
    const gate = new QwenConcurrencyGate();
    const controller = new AbortController();
    controller.abort();
    await expect(gate.acquire('high', controller.signal)).rejects.toThrow(/Aborted/);
  });
});
