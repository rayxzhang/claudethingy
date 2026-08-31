#!/usr/bin/env python
import os
import select
import struct
import sys

EV_REL = 2
REL_HWHEEL = 6
REL_WHEEL = 8
FMT24 = "QQHHi"
SIZE24 = struct.calcsize(FMT24)


def main():
    path = "/dev/input/event1"
    fd = os.open(path, os.O_RDONLY)
    sys.stdout.write("ready\n")
    sys.stdout.flush()
    while True:
        readable, _, _ = select.select([fd], [], [], 1.0)
        if not readable:
            continue
        buf = os.read(fd, SIZE24 * 8)
        for i in range(0, len(buf) - SIZE24 + 1, SIZE24):
            _sec, _usec, typ, code, value = struct.unpack(FMT24, buf[i : i + SIZE24])
            if typ != EV_REL:
                continue
            if code not in (REL_HWHEEL, REL_WHEEL):
                continue
            if value > 0:
                sys.stdout.write("+\n")
            elif value < 0:
                sys.stdout.write("-\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
