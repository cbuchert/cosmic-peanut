import threading
import time

from tools.cpu_budget import thread_cpu


def test_thread_cpu_reports_each_thread_by_native_id_with_its_cpu_time():
    stop = threading.Event()

    def spin() -> None:
        end = time.thread_time() + 0.2
        while time.thread_time() < end:
            pass
        stop.wait()

    t = threading.Thread(target=spin, name="spin")
    t.start()
    try:
        time.sleep(0.5)
        threads = thread_cpu()
    finally:
        stop.set()
        t.join()
    assert t.native_id in threads and threading.main_thread().native_id in threads
    assert 0.15 < threads[t.native_id].cpu_s < 0.5
