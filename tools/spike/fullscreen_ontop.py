import sys
import threading
import time

import AppKit
import webview
from PyObjCTools import AppHelper

frameless = sys.argv[1] == "1"
ontop = sys.argv[2] == "1"
win = webview.create_window(
    "fs",
    html="<body style='background:#234'>",
    frameless=frameless,
    on_top=ontop,
    width=800,
    height=450,
)


def st():
    b = {}
    e = threading.Event()

    def r():
        b["fs"] = bool(int(win.native.styleMask()) & AppKit.NSWindowStyleMaskFullScreen)
        b["w"] = win.native.frame().size.width
        b["cb"] = int(win.native.collectionBehavior())
        e.set()

    AppHelper.callAfter(r)
    e.wait(1)
    return b


def drv():
    time.sleep(2)
    out = []
    for n in range(2):
        if "--drop" in sys.argv:
            win.on_top = False
            time.sleep(0.2)
        win.toggle_fullscreen()

        seq = []
        for _ in range(14):
            time.sleep(0.25)
            seq.append(st()["fs"])
        out.append((n, seq, st()))
    print("frameless", frameless, "ontop", ontop, out, flush=True)
    win.destroy()


webview.start(drv)
