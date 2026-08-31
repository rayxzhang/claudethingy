#!/usr/bin/env python
import os
import select
import struct
import sys
import time

DEVICES = [
    ("/dev/input/event0", "gpio-keys"),
    ("/dev/input/event1", "rotary"),
    ("/dev/input/event2", "vkeypad"),
]

KEY_NAMES = {
    1: "ESC/Back",
    2: "KEY_1/Preset1",
    3: "KEY_2/Preset2",
    4: "KEY_3/Preset3",
    5: "KEY_4/Preset4",
    28: "ENTER/DialPress",
    50: "KEY_M",
}

EV_SYN = 0
EV_KEY = 1
EV_REL = 2
REL_HWHEEL = 6

FMT24 = "QQHHi"
FMT16 = "llHHi"
SIZE24 = struct.calcsize(FMT24)
SIZE16 = struct.calcsize(FMT16)


def decode(buf):
    if len(buf) == SIZE24:
        _sec, _usec, typ, code, value = struct.unpack(FMT24, buf)
        return typ, code, value
    if len(buf) == SIZE16:
        _sec, _usec, typ, code, value = struct.unpack(FMT16, buf)
        return typ, code, value
    return None


def label(typ, code, value):
    if typ == EV_KEY:
        name = KEY_NAMES.get(code, "KEY_%s" % code)
        edge = "down" if value == 1 else ("up" if value == 0 else "repeat")
        return "%s %s" % (name, edge)
    if typ == EV_REL and code == REL_HWHEEL:
        return "DIAL tick %+d" % value
    if typ == EV_REL:
        return "REL code=%s value=%s" % (code, value)
    return None


def main():
    seconds = int(sys.argv[1]) if len(sys.argv) > 1 else 90
    fds = []
    for path, name in DEVICES:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            fds.append((fd, path, name))
            print("listening %s (%s)" % (name, path))
        except OSError as err:
            print("skip %s: %s" % (path, err))
    sys.stdout.flush()
    if not fds:
        print("no input devices")
        return 1

    deadline = time.time() + seconds
    print("READY press buttons now")
    sys.stdout.flush()
    while time.time() < deadline:
        readable, _, _ = select.select([fd for fd, _, _ in fds], [], [], 0.5)
        for fd, path, name in fds:
            if fd not in readable:
                continue
            try:
                buf = os.read(fd, 256)
            except OSError:
                continue
            size = SIZE24 if len(buf) % SIZE24 == 0 else SIZE16
            for i in range(0, len(buf), size):
                parsed = decode(buf[i : i + size])
                if not parsed:
                    continue
                typ, code, value = parsed
                text = label(typ, code, value)
                if text:
                    print("HIT %s %s" % (name, text))
                    sys.stdout.flush()
    print("DONE")
    sys.stdout.flush()
    for fd, _, _ in fds:
        os.close(fd)
    return 0


if __name__ == "__main__":
    sys.exit(main())
