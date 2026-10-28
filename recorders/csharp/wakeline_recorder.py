#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

def parse_lines(text):
    parts = text.split(":", 1)
    if len(parts) != 2:
        raise argparse.ArgumentTypeError("lines must look like start:end")
    try:
        start = int(parts[0]); end = int(parts[1])
    except ValueError:
        raise argparse.ArgumentTypeError("lines must be integers")
    if start < 1 or end < start:
        raise argparse.ArgumentTypeError("line range is invalid")
    return start, end

def build_parser():
    p = argparse.ArgumentParser(prog="wakeline_recorder_csharp")
    p.add_argument("--file", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--lines", required=True, type=parse_lines)
    p.add_argument("--out", required=True)
    p.add_argument("--max-calls", type=int, default=100)
    p.add_argument("--max-events", type=int, default=10000)
    p.add_argument("--max-bytes", type=int, default=0)
    p.add_argument("--mask", default="")
    p.add_argument("rest", nargs=argparse.REMAINDER)
    return p

def j(s):
    if s is None: return "null"
    return json.dumps(s)

def fail(out, msg, where="trace"):
    try:
        with open(out,'a',encoding='utf-8') as f:
            f.write(json.dumps({"k":"failure","why":msg[:500],"where":where})+"\n")
    except: pass
    print("wakeline: %s"%msg,file=sys.stderr)

def instrument(src, name, line0, line1):
    if 'Wakeline.Enter' in src:
        return src
    lines = src.split('\n')
    mname = name.split('.')[-1] if name else 'method'
    start = -1
    for i,l in enumerate(lines):
        s = l.strip()
        if s.startswith('//') or s.startswith('#'): continue
        if mname in l and '(' in l:
            if s.startswith(('if ','for ','while ','switch ','catch ')): continue
            start = i
            break
    if start == -1: return None
    brace = -1
    for i in range(start, min(start+60,len(lines))):
        if '{' in lines[i]:
            brace = i
            break
    if brace == -1: return None
    # find end brace
    depth = 0
    end_brace = -1
    for i in range(brace, len(lines)):
        depth += lines[i].count('{') - lines[i].count('}')
        if depth == 0 and i > brace:
            end_brace = i
            break
    if end_brace == -1: return None
    indent = '\t\t'
    new_lines = []
    for i in range(0, brace+1):
        new_lines.append(lines[i])
    new_lines.append(indent + 'var __wk_st__ = Wakeline.Enter("%s", %d, %d, new System.Collections.Generic.Dictionary<string,object>());' % (mname.replace('\\','\\\\').replace('"','\\"'), line0, line1))
    new_lines.append(indent + 'try {')
    for i in range(brace+1, end_brace):
        l = lines[i]
        if l.strip() == '':
            new_lines.append(l)
        else:
            new_lines.append('\t\t\t' + l)
    new_lines.append(indent + '} catch (Exception __wk_ex__) { if (__wk_st__ != null) Wakeline.Err(__wk_st__, __wk_ex__); throw; } finally { if (__wk_st__ != null) Wakeline.End(__wk_st__); }')
    new_lines.append(lines[end_brace])
    for i in range(end_brace+1, len(lines)):
        new_lines.append(lines[i])
    res = '\n'.join(new_lines)
    return res

def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    program_args = args.rest
    if program_args and program_args[0] == '--': program_args = program_args[1:]
    target = os.path.realpath(args.file)
    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        with open(out,'w',encoding='utf-8') as f:
            f.write(json.dumps({"k":"ver","v":1})+"\n")
            try:
                sm = int(os.stat(target).st_mtime*1000)
                f.write(json.dumps({"k":"meta","src":target,"sm":sm})+"\n")
            except: f.write(json.dumps({"k":"meta","src":target})+"\n")
    except Exception as e:
        print('wakeline: cannot write recording: %s'%e,file=sys.stderr)
    mcs = os.environ.get('WAKELINE_CSC') or shutil.which('mcs') or shutil.which('csc')
    mono = os.environ.get('WAKELINE_MONO') or shutil.which('mono')
    if not mcs:
        fail(out,'no c# compiler found','install'); return
    if not mono:
        fail(out,'no mono found','install'); return
    here = os.path.dirname(os.path.abspath(__file__))
    runtime = os.path.join(here,'wk_csharp_runner.cs')
    try:
        with open(target,'r',encoding='utf-8',errors='ignore') as f: src = f.read()
    except Exception as e:
        fail(out,'cannot read source','read'); return
    inst = instrument(src,args.name,args.lines[0],args.lines[1])
    if inst is None:
        print('wakeline: instrumentation failed',file=sys.stderr)
        fail(out,'could not instrument target method','trace')
        inst = src
    tmpdir = tempfile.mkdtemp(prefix='wakeline_cs_')
    try:
        inst_path = os.path.join(tmpdir, os.path.basename(target))
        with open(inst_path,'w',encoding='utf-8') as f: f.write(inst)
        src_dir = os.path.dirname(target)
        for fn in os.listdir(src_dir):
            if fn == os.path.basename(target):
                continue
            if fn.endswith('.cs'):
                try:
                    shutil.copy(os.path.join(src_dir, fn), os.path.join(tmpdir, fn))
                except Exception:
                    pass
        exe_path = os.path.join(tmpdir,'prog.exe')
        cs_files = []
        for fn in os.listdir(tmpdir):
            if fn.endswith('.cs'):
                cs_files.append(os.path.join(tmpdir, fn))
        cmd = [mcs,'-debug','-r:System.Core','-out:'+exe_path,runtime] + cs_files
        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=tmpdir)
        if proc.returncode != 0:
            print(proc.stderr.decode('utf-8',errors='ignore'),file=sys.stderr)
            fail(out,'compile failed','trace'); return
        env = os.environ.copy()
        env['wakeline_out']=out; env['wakeline_file']=target
        env['wakeline_max_calls']=str(args.max_calls)
        env['wakeline_max_events']=str(args.max_events)
        env['wakeline_max_bytes']=str(args.max_bytes)
        env['wakeline_mask']=args.mask
        p = subprocess.Popen([mono,exe_path]+program_args,cwd=os.path.dirname(target),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        try:
            out_s,err_s = p.communicate(timeout=300)
        except subprocess.TimeoutExpired:
            p.kill(); out_s,err_s = p.communicate()
            fail(out,'timeout','trace'); return
        if out_s: sys.stdout.buffer.write(out_s)
        if err_s: sys.stderr.buffer.write(err_s)
    finally:
        try: shutil.rmtree(tmpdir)
        except: pass

if __name__=='__main__': main()
