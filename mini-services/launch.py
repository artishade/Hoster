#!/usr/bin/env python3
"""Double-fork daemon launcher — survives sandbox session reaping (PPID 1).

Usage: python3 launch.py <service-dir>
"""
import os, sys, subprocess, time

def main():
    svc_dir = sys.argv[1]
    log = open(os.path.join(svc_dir, 'service.log'), 'ab', buffering=0)
    # fork #1
    if os.fork() > 0:
        time.sleep(0.8)  # let it boot so the caller can health-check
        return
    os.setsid()
    # fork #2
    if os.fork() > 0:
        os._exit(0)
    os.chdir(svc_dir)
    fd = os.open(os.devnull, os.O_RDWR)
    os.dup2(fd, 0)
    os.dup2(log.fileno(), 1)
    os.dup2(log.fileno(), 2)
    if fd > 2:
        os.close(fd)
    env = dict(os.environ)
    env['FORCE_COLOR'] = '0'
    subprocess.run(['bun', 'run', 'dev'], env=env, cwd=svc_dir)
    os._exit(0)

main()
