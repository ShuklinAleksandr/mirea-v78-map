#!/usr/bin/env python3
"""Portable, sequential regeneration using one Python interpreter."""
import argparse
import subprocess
import sys
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def main():
    parser=argparse.ArgumentParser(description='Regenerate interiors, photo-informed exteriors, cached OSM context and QA. Uses source/maps by default; no original archives or network access required.')
    parser.add_argument('--from-archives',action='store_true',help='First re-extract/audit all three original ZIP/XAPK/HTML inputs; requires them to exist.')
    parser.add_argument('--archives-dir',type=Path,help='Directory of the original files, passed to build-data.py only with --from-archives.')
    args=parser.parse_args()
    if args.archives_dir and not args.from_archives:parser.error('--archives-dir is meaningful only with --from-archives')
    # The hall's visible mosaic facade is derived from the final display facade bands.
    scripts=['build-data.py','build-stair-layouts.py','build-exterior-special.py','build-exterior-shells.py',
        'build-exterior-hall.py','build-exterior-context.py','build-photo-details.py','check-data.py',
        'check-stair-layouts.py','check-exterior-connections.py','build-routing.py']
    for name in scripts:
        command=[sys.executable,str(ROOT/'scripts'/name)]
        if name=='build-data.py' and args.from_archives:
            command.append('--from-archives')
            if args.archives_dir:command.extend(['--archives-dir',str(args.archives_dir.resolve())])
        print('\nRunning '+name+' with '+sys.executable,flush=True)
        subprocess.run(command,cwd=ROOT,check=True)
    print('\nData pipeline complete. Run npm test for application/data integration checks.',flush=True)

if __name__=='__main__':
    try:main()
    except subprocess.CalledProcessError as exc:
        print(f'Data pipeline stopped: {Path(exc.cmd[1]).name} exited with code {exc.returncode}.',file=sys.stderr)
        raise SystemExit(exc.returncode)
