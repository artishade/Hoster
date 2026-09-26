#!/usr/bin/env python3
"""Double-fork dev-server daemon — survives sandbox session reaping (PPID 1)."""
import os, subprocess, sys, time

os.chdir('/home/z/my-project')
log = open('/home/z/my-project/dev.log', 'ab', buffering=0)
if os.fork() > 0:
    time.sleep(4)
    sys.exit(0)
os.setsid()
if os.fork() > 0:
    os._exit(0)
fd = os.open(os.devnull, os.O_RDWR)
os.dup2(fd, 0)
os.dup2(log.fileno(), 1)
os.dup2(log.fileno(), 2)
if fd > 2:
    os.close(fd)
env = dict(os.environ)
env['FORCE_COLOR'] = '0'
subprocess.run(['bun', 'run', 'dev'], env=env, cwd='/home/z/my-project')
os._exit(0)
