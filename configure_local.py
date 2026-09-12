#!/usr/bin/env python3
"""Set the private local default credential without putting it in HTML or arguments."""
import argparse
import getpass
import json
import os
from pathlib import Path
import sys
import warnings


def save_profile(file, key):
    file = Path(file)
    if not key.strip():
        raise ValueError('Key不可为空')
    if file.is_symlink() or file.parent.is_symlink():
        raise ValueError('配置位置不可为符号链接')
    file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(file.parent, 0o700)
    temporary = file.with_name(file.name+'.tmp')
    fd = os.open(temporary, os.O_WRONLY|os.O_CREAT|os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd,'w',encoding='utf-8') as out:
            json.dump({'endpoint':'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions','api_key':key.strip()},out)
            out.write('\n')
        os.replace(temporary,file)
        os.chmod(file,0o600)
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile',type=Path,default=Path(__file__).resolve().parent/'.private/model_config.json')
    parser.add_argument('--stdin-key',action='store_true',help='为自动化使用；调用者须关闭终端回显')
    args=parser.parse_args()
    if args.stdin_key:
        print('KEY_STDIN_READY',flush=True)
        key=sys.stdin.readline().strip()
    else:
        with warnings.catch_warnings():
            warnings.simplefilter('error',getpass.GetPassWarning)
            key=getpass.getpass('BigModel Coding Plan Key（不显示）: ').strip()
    save_profile(args.profile,key)
    print('已保存本机默认凭据；目录权限700，文件权限600。')


if __name__=='__main__':
    main()
