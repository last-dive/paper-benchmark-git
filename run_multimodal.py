#!/usr/bin/env python3
"""Run full-page multimodal scoring with the user's private local profile.

Example: python3 run_multimodal.py --prepared PATH --output NEW_DIR --repeats 5
Requires Node.js 20+; extra arguments go to multimodal_runner.cjs.
"""
import argparse
from pathlib import Path
import shutil
import subprocess
import sys
from start_local import load_profile


def main():
    root=Path(__file__).resolve().parent
    parser=argparse.ArgumentParser(description=__doc__,add_help=False)
    parser.add_argument('--profile',type=Path,default=root/'.private/model_config.json')
    options,args=parser.parse_known_args()
    node=shutil.which('node')
    if not node:raise SystemExit('需要 Node.js 20+。')
    command=[node,str(root/'multimodal_runner.cjs'),*args]
    if '--help' in args:return subprocess.call(command)
    key=load_profile(options.profile)
    child=subprocess.Popen(command,stdin=subprocess.PIPE,text=True)
    child.stdin.write(key+'\n');child.stdin.flush();child.stdin.close();key=None
    try:return child.wait()
    except KeyboardInterrupt:
        try:return child.wait(timeout=15)
        except subprocess.TimeoutExpired:child.terminate();return child.wait()


if __name__=='__main__':sys.exit(main())
