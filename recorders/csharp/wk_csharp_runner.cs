using System;
using System.IO;
using System.Text;
using System.Collections.Generic;

class WkState {
    public string id;
    public string name;
    public int l0, l1;
    public DateTime started;
    public int depth;
    public int steps;
    public bool capped;
    public string capReason;
    public bool ended;
    public object lastErr;
    public object returned;
    public bool hasReturn;
}

class Wakeline {
    static StreamWriter w;
    static string outFile;
    static string srcFile;
    static int maxCalls = 100;
    static int maxEvents = 10000;
    static long maxBytes = 0;
    static string mask = "";
    static int calls = 0;
    static int nextId = 1;
    static int active = 0;
    static bool stopped = false;
    static bool hardStop = false;
    static string hit = null;
    static object mu = new object();
    static List<string> maskList = new List<string>();
    static long bytesWritten = 0;
    
    static bool inited = false;
    
    public static void Init() {
        if (inited) return;
        inited = true;
        try {
            outFile = Environment.GetEnvironmentVariable("wakeline_out");
            srcFile = Environment.GetEnvironmentVariable("wakeline_file");
            string mc = Environment.GetEnvironmentVariable("wakeline_max_calls");
            string me = Environment.GetEnvironmentVariable("wakeline_max_events");
            string mb = Environment.GetEnvironmentVariable("wakeline_max_bytes");
            string mk = Environment.GetEnvironmentVariable("wakeline_mask");
            if (mc != null) int.TryParse(mc, out maxCalls);
            if (me != null) int.TryParse(me, out maxEvents);
            if (mb != null) long.TryParse(mb, out maxBytes);
            if (mk != null) mask = mk;
            foreach (var p in mask.Split(new char[] {','}, StringSplitOptions.RemoveEmptyEntries)) {
                var t = p.Trim();
                if (t != "") maskList.Add(t);
            }
            if (string.IsNullOrEmpty(outFile)) return;
            string dir = Path.GetDirectoryName(Path.GetFullPath(outFile));
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            w = new StreamWriter(outFile, false, Encoding.UTF8);
            WriteLineRaw("{\"k\":\"ver\",\"v\":1}");
            try {
                var fi = new FileInfo(srcFile);
                var sm = (long)(fi.LastWriteTimeUtc - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
                WriteLineRaw("{\"k\":\"meta\",\"src\":" + J(srcFile) + ",\"sm\":" + sm + "}");
            } catch {
                WriteLineRaw("{\"k\":\"meta\",\"src\":" + J(srcFile) + "}");
            }
            w.Flush();
        } catch (Exception e) {
            Console.Error.WriteLine("wakeline: " + e.Message);
        }
    }
    
    static string J(string s) {
        if (s == null) return "null";
        StringBuilder sb = new StringBuilder();
        sb.Append('"');
        foreach (char c in s) {
            if (c == '\\') sb.Append("\\\\");
            else if (c == '"') sb.Append("\\\"");
            else if (c == '\n') sb.Append("\\n");
            else if (c == '\r') sb.Append("\\r");
            else if (c == '\t') sb.Append("\\t");
            else sb.Append(c);
        }
        sb.Append('"');
        return sb.ToString();
    }
    
    static void WriteLineRaw(string line) {
        lock (mu) {
            if (w == null) return;
            if (hardStop) return;
            if (maxBytes > 0 && bytesWritten + line.Length + 1 > maxBytes) {
                if (hit == null) {
                    hit = "max_bytes";
                    stopped = true;
                    hardStop = true;
                    string cap = "{\"k\":\"cap_hit\",\"r\":\"max_bytes\",\"b\":" + bytesWritten + "}";
                    try { w.WriteLine(cap); bytesWritten += cap.Length + 1; w.Flush(); } catch {}
                }
                return;
            }
            try { w.WriteLine(line); bytesWritten += line.Length + 1; } catch {}
        }
    }
    
    static void WriteLineForce(string line) {
        lock (mu) {
            if (w == null) return;
            try { w.WriteLine(line); bytesWritten += line.Length + 1; } catch {}
        }
    }
    
    public static WkState Enter(string name, int line0, int line1, object argsObj) {
        Init();
        lock (mu) {
            if (w == null || hardStop) return null;
            if (stopped || calls >= maxCalls) {
                if (hit == null) {
                    hit = "max_calls";
                    stopped = true;
                    string cap = "{\"k\":\"cap_hit\",\"r\":\"max_calls\",\"b\":" + bytesWritten + "}";
                    WriteLineForce(cap);
                }
                return null;
            }
            string id = "c" + nextId++;
            calls++;
            int depth = active;
            active++;
            string args = "{}";
            try {
                if (argsObj == null) args = "{}";
                else if (argsObj is System.Collections.IDictionary) args = "{}";
                else {
                    string aenc = Enc(argsObj);
                    if (aenc != null && aenc.Length > 0 && aenc[0] == '{') args = aenc;
                    else args = "{}";
                }
            } catch { args = "{}"; }
            WkState st = new WkState();
            st.id = id; st.name = name; st.l0 = line0; st.l1 = line1; st.started = DateTime.UtcNow; st.depth = depth; st.steps = 0; st.capped = false; st.capReason = "none"; st.ended = false;
            long t = (long)(st.started - new DateTime(1970,1,1,0,0,0,DateTimeKind.Utc)).TotalMilliseconds;
            string ev = "{\"k\":\"call_start\",\"i\":" + J(id) + ",\"f\":" + J(name) + ",\"l0\":" + line0 + ",\"l1\":" + line1 + ",\"dp\":" + depth + ",\"a\":" + args + ",\"t\":" + t + "}";
            WriteLineRaw(ev);
            return st;
        }
    }
    
    public static void End(WkState st) {
        if (st == null) return;
        lock (mu) {
            if (st.ended) return;
            st.ended = true;
            long ms = (long)(DateTime.UtcNow - st.started).TotalMilliseconds;
            string ev;
            if (st.lastErr != null) {
                ev = "{\"k\":\"call_end\",\"i\":" + J(st.id) + ",\"s\":" + st.steps + ",\"o\":\"throw\",\"x\":" + ExInfo(st.lastErr) + ",\"ms\":" + ms + ",\"c\":" + J(st.capReason) + "}";
            } else {
                string r = st.hasReturn ? Enc(st.returned) : "null";
                ev = "{\"k\":\"call_end\",\"i\":" + J(st.id) + ",\"s\":" + st.steps + ",\"o\":\"return\",\"r\":" + r + ",\"ms\":" + ms + ",\"c\":" + J(st.capReason) + "}";
            }
            WriteLineForce(ev);
            active--;
            if (active < 0) active = 0;
        }
        try { if (w != null) w.Flush(); } catch {}
    }
    
    static string ExInfo(object v) {
        string t = "Exception";
        string m = "";
        string[] s = new string[0];
        if (v != null) {
            t = v.GetType().Name;
            try { m = v.ToString(); if (m != null && m.Length > 1000) m = m.Substring(0,1000); } catch {}
            try {
                Exception ex = v as Exception;
                if (ex != null && ex.StackTrace != null) {
                    string[] lines = ex.StackTrace.Split(new char[] { '\n' }, StringSplitOptions.None);
                    List<string> list = new List<string>();
                    foreach (string l in lines) {
                        string tr = l.Trim();
                        if (tr != "" && list.Count < 20) list.Add(tr);
                    }
                    s = list.ToArray();
                }
            } catch {}
        }
        StringBuilder sb = new StringBuilder();
        sb.Append("{\"t\":").Append(J(t)).Append(",\"m\":").Append(J(m)).Append(",\"s\":[");
        for (int i=0; i<s.Length; i++) {
            if (i>0) sb.Append(",");
            sb.Append(J(s[i]));
        }
        sb.Append("]}");
        return sb.ToString();
    }
    
    static string Enc(object v) {
        if (v == null) return "null";
        Type t = v.GetType();
        if (t == typeof(bool)) return ((bool)v) ? "true" : "false";
        if (t == typeof(int)) {
            int iv = (int)v;
            if (iv > 9007199254740991 || iv < -9007199254740991) return "{\"$\":\"int\",\"v\":\"" + iv + "\"}";
            return iv.ToString();
        }
        if (t == typeof(long)) {
            long lv = (long)v;
            if (lv > 9007199254740991 || lv < -9007199254740991) return "{\"$\":\"int\",\"v\":\"" + lv + "\"}";
            return lv.ToString();
        }
        if (t == typeof(string)) {
            string s = (string)v;
            if (s.Length > 4096) return "{\"$\":\"str\",\"v\":" + J(s.Substring(0,4096)) + ",\"n\":" + s.Length + ",\"cut\":true}";
            return J(s);
        }
        try {
            return J(v.ToString());
        } catch {
            return J("");
        }
    }
    
    public static object Ret(WkState st, object v) {
        if (st != null) { st.returned = v; st.hasReturn = true; }
        return v;
    }
    
    public static void Err(WkState st, object ex) {
        if (st == null) return;
        st.lastErr = ex;
    }
    
    public static void At(WkState st, int line, object vals) {}
    
    public static void Close() {
        try { if (w != null) { w.Flush(); w.Close(); } } catch {}
    }
}
