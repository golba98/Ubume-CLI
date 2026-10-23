#!/usr/bin/env python3
"""Separate PTY transport from the deliberately minimal Python VT emulator's parsing cost."""
import threading, time
import resize

class ConcurrentDriver(resize.Driver):
    def __init__(self, sandbox, repo):
        super().__init__(sandbox, repo)
        self.stop_reader = threading.Event()
        pump = self.session.pump
        close = self.session.close
        def read():
            while not self.stop_reader.is_set(): pump(.002)
        self.reader = threading.Thread(target=read, daemon=True)
        self.reader.start()
        self.session.pump = lambda seconds, reader_delay=0: self.stop_reader.wait(min(seconds,.002))
        def finish():
            self.stop_reader.set(); self.reader.join(timeout=1); close()
        self.session.close = finish
    def pump(self, seconds=.002):
        self.stop_reader.wait(min(seconds,.002))
        # Snapshot the immutable byte buffer before advancing the cursor: the
        # raw reader may append while the main thread interprets the old frame.
        data=self.session.output;chunk=data[self.offset:];self.offset=len(data)
        if chunk:
            start=time.perf_counter_ns();self.screen.feed(self.decoder.decode(chunk));self.parse_ms+=(time.perf_counter_ns()-start)/1e6
        return chunk

resize.Driver=ConcurrentDriver
result=resize.run(resize.REPO,'history',1,1,resize.REPO/'docs/_reports/performance/resize-2026-10-22/stress-1000-fast-reader',1000,True,4)
assert result['eventLoopDelayMs']['p95'] < 100, 'application loop remains delayed with raw PTY reads decoupled'
print('PASS 1,000-turn history with concurrent PTY transport and separate VT interpretation',flush=True)
