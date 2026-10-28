#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

HEADER_CREDIT = "// c++ work by sora - https://github.com/q2hp0\n"

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
    p = argparse.ArgumentParser(prog="wakeline_recorder_cpp")
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
        with open(out, "a", encoding="utf-8") as f:
            f.write(json.dumps({"k":"failure","why":msg[:500],"where":where}) + "\n")
    except: pass
    print("wakeline: %s" % msg, file=sys.stderr)

def instrument(src, name, line0, line1):
    if 'wk_enter' in src:
        if HEADER_CREDIT.strip() not in src: src = HEADER_CREDIT + src
        if '#include "wk_cpp_runtime.hpp"' not in src and '<wk_cpp_runtime.hpp>' not in src:
            src = '#include "wk_cpp_runtime.hpp"\n' + src
        return src
    # add headers
    if HEADER_CREDIT.strip() not in src: src = HEADER_CREDIT + src
    if '#include "wk_cpp_runtime.hpp"' not in src and '<wk_cpp_runtime.hpp>' not in src:
        # insert after first include block
        src = '#include "wk_cpp_runtime.hpp"\n' + src
    lines = src.split('\n')
    mname = name.split('::')[-1].split('.')[-1] if name else 'func'
    start = -1
    for i,l in enumerate(lines):
        s = l.strip()
        if s.startswith('//') or s.startswith('#'): continue
        if mname and mname in l and '(' in l:
            # skip obvious keywords
            if re_match(s): continue
            start = i
            break
    if start == -1: return None
    # find brace
    brace = -1
    for i in range(start, min(start+60,len(lines))):
        if '{' in lines[i]:
            brace = i
            break
    if brace == -1: return None
    # find matching brace
    depth = 0
    end_brace = -1
    for i in range(brace, len(lines)):
        depth += lines[i].count('{') - lines[i].count('}')
        if depth == 0 and i > brace:
            end_brace = i
            break
    if end_brace == -1: return None
    # build new content
    new_lines = []
    # copy up to brace
    for i in range(0, brace+1):
        new_lines.append(lines[i])
    indent = '    '
    # insert tracing
    new_lines.append(indent + 'WkState* __wk_st__ = wk_enter("%s", %d, %d, nullptr);' % (mname.replace('\\','\\\\').replace('"','\\"'), line0, line1))
    new_lines.append(indent + 'struct __wk_guard__ { WkState* s; bool threw=false; ~__wk_guard__(){ if(s){ if(threw){ /* already handled */ } wk_end(s); } } } __wk_g__{__wk_st__};')
    new_lines.append(indent + 'try {')
    # copy body
    for i in range(brace+1, end_brace):
        l = lines[i]
        if l.strip() == '':
            new_lines.append(l)
        else:
            new_lines.append('        ' + l)
    new_lines.append(indent + '} catch(...) { if(__wk_st__) { wk_exc(__wk_st__, nullptr); } __wk_g__.threw = true; throw; }')
    # add closing brace of function
    new_lines.append(lines[end_brace])
    # copy rest
    for i in range(end_brace+1, len(lines)):
        new_lines.append(lines[i])
    res = '\n'.join(new_lines)
    if HEADER_CREDIT.strip() not in res: res = HEADER_CREDIT + res
    if '#include "wk_cpp_runtime.hpp"' not in res and '<wk_cpp_runtime.hpp>' not in res:
        res = '#include "wk_cpp_runtime.hpp"\n' + res
    return res

def re_match(s):
    bad = ['if(', 'for(', 'while(', 'switch(', 'catch(', 'else', 'class ', 'struct ', 'enum ', 'namespace ']
    for b in bad:
        if s.startswith(b) or (' ' + b) in s:
            # be more specific
            if s.startswith(('if ','for ','while ','switch ','catch ')): return True
            if s == 'else' or s.startswith('else '): return True
    return False

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
    cxx = os.environ.get('WAKELINE_CXX') or shutil.which('g++') or shutil.which('clang++')
    if not cxx:
        fail(out,'no c++ compiler found','install'); return
    here = os.path.dirname(os.path.abspath(__file__))
    runtime_cpp = os.path.join(here,'wk_cpp_runtime.cpp')
    try:
        with open(target,'r',encoding='utf-8',errors='ignore') as f: src = f.read()
    except Exception as e:
        fail(out,'cannot read source','read'); return
    inst = instrument(src,args.name,args.lines[0],args.lines[1])
    if inst is None:
        print('wakeline: instrumentation failed',file=sys.stderr)
        fail(out,'could not instrument target method','trace')
        inst = src
    if HEADER_CREDIT.strip() not in inst: inst = HEADER_CREDIT + inst
    if '#include "wk_cpp_runtime.hpp"' not in inst and '<wk_cpp_runtime.hpp>' not in inst:
        inst = '#include "wk_cpp_runtime.hpp"\n' + inst
    tmpdir = tempfile.mkdtemp(prefix='wakeline_cpp_')
    try:
        inst_path = os.path.join(tmpdir, os.path.basename(target))
        with open(inst_path,'w',encoding='utf-8') as f: f.write(inst)
        # copy other source files from source dir
        src_dir = os.path.dirname(target)
        for fn in os.listdir(src_dir):
            if fn == os.path.basename(target):
                continue
            if fn.endswith('.cpp') or fn.endswith('.cc') or fn.endswith('.cxx') or fn.endswith('.hpp') or fn.endswith('.h'):
                try:
                    shutil.copy(os.path.join(src_dir, fn), os.path.join(tmpdir, fn))
                except Exception:
                    pass
        exe_path = os.path.join(tmpdir,'prog')
        # collect all cpp files
        cpp_files = []
        for fn in os.listdir(tmpdir):
            if fn.endswith('.cpp') or fn.endswith('.cc') or fn.endswith('.cxx') or fn.endswith('.c'):
                cpp_files.append(os.path.join(tmpdir, fn))
        if runtime_cpp not in cpp_files:
            cpp_files.append(runtime_cpp)
        cmd = [cxx,'-std=c++17','-g','-O0','-I'+here,'-I'+tmpdir,'-o',exe_path] + cpp_files
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
        p = subprocess.Popen([exe_path]+program_args,cwd=os.path.dirname(target),env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
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
#
