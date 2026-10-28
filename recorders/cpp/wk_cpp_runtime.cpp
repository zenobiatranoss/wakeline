// c++ work by sora - https://github.com/q2hp0
#include "wk_cpp_runtime.hpp"
#include <fstream>
#include <iostream>
#include <sstream>
#include <chrono>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>

static std::ofstream* g_w = nullptr;
static std::string g_out;
static std::string g_file;
static int g_max_calls = 100;
static int g_max_events = 10000;
static long g_max_bytes = 0;
static int g_calls = 0;
static int g_next = 1;
static int g_active = 0;
static bool g_stopped = false;
static bool g_hard = false;
static std::string g_hit;
static std::mutex g_mu;
static long long g_bytes = 0;
static bool g_inited = false;

static std::string jstr(const std::string& s) {
    std::string out = "\"";
    for(char c : s) {
        if(c == '\\') { out += "\\\\"; }
        else if(c == '"') { out += "\\\""; }
        else if(c == '\n') { out += "\\n"; }
        else if(c == '\r') { out += "\\r"; }
        else if(c == '\t') { out += "\\t"; }
        else out += c;
    }
    out += "\"";
    return out;
}
 
static void init() {
    if(g_inited) return;
    g_inited = true;
    const char* eo = std::getenv("wakeline_out");
    const char* ef = std::getenv("wakeline_file");
    if(eo) g_out = eo;
    if(ef) g_file = ef;
    if(std::getenv("wakeline_max_calls")) g_max_calls = atoi(std::getenv("wakeline_max_calls"));
    if(std::getenv("wakeline_max_events")) g_max_events = atoi(std::getenv("wakeline_max_events"));
    if(std::getenv("wakeline_max_bytes")) g_max_bytes = atoll(std::getenv("wakeline_max_bytes"));
    if(g_out.empty()) return;
    g_w = new std::ofstream(g_out.c_str(), std::ios::out);
    if(g_w && g_w->is_open()) {
        *g_w << "{\"k\":\"ver\",\"v\":1}\n";
        if(!g_file.empty()) {
            *g_w << "{\"k\":\"meta\",\"src\":" << jstr(g_file) << "}\n";
        } else {
            *g_w << "{\"k\":\"meta\",\"src\":null}\n";
        }
        g_w->flush();
    }
}
 
static long long nowms() {
    auto now = std::chrono::system_clock::now();
    return std::chrono::duration_cast<std::chrono::milliseconds>(now.time_since_epoch()).count();
}

extern "C" WkState* wk_enter(const char* name, int line0, int line1, void* args) {
    init();
    std::lock_guard<std::mutex> lk(g_mu);
    if(!g_w || !g_w->is_open() || g_hard) return nullptr;
    if(g_stopped || g_calls >= g_max_calls) {
        if(g_hit.empty()) {
            g_hit = "max_calls";
            g_stopped = true;
            std::string cap = "{\"k\":\"cap_hit\",\"r\":\"max_calls\",\"b\":" + std::to_string(g_bytes) + "}\n";
            *g_w << cap;
            g_bytes += cap.size();
            g_w->flush();
        }
        return nullptr;
    }
    std::string id = "c" + std::to_string(g_next++);
    g_calls++;
    int depth = g_active++;
    WkState* st = new WkState();
    st->id = id;
    st->name = name ? name : "";
    st->l0 = line0; st->l1 = line1;
    st->started = nowms();
    st->depth = depth;
    st->steps = 0;
    st->capped = false;
    st->cap_reason = "none";
    st->ended = false;
    st->threw = false;
    std::string ev = "{\"k\":\"call_start\",\"i\":" + jstr(id) + ",\"f\":" + jstr(st->name) + ",\"l0\":" + std::to_string(line0) + ",\"l1\":" + std::to_string(line1) + ",\"dp\":" + std::to_string(depth) + ",\"a\":{},\"t\":" + std::to_string(st->started) + "}\n";
    if(g_max_bytes == 0 || g_bytes + ev.size() <= g_max_bytes) {
        *g_w << ev;
        g_bytes += ev.size();
        g_w->flush();
    } else {
        if(g_hit.empty()) { g_hit = "max_bytes"; g_stopped = true; g_hard = true; }
    }
    return st;
}

extern "C" void wk_exc(WkState* st, void* ex) {
    if(!st || st->ended) return;
    st->threw = true;
}

extern "C" void wk_end(WkState* st) {
    if(!st) return;
    std::lock_guard<std::mutex> lk(g_mu);
    if(st->ended) return;
    st->ended = true;
    long long ms = nowms() - st->started;
    std::string ev;
    if(st->threw) {
        ev = "{\"k\":\"call_end\",\"i\":" + jstr(st->id) + ",\"s\":" + std::to_string(st->steps) + ",\"o\":\"throw\",\"x\":{\"t\":\"Exception\",\"m\":\"\",\"s\":[]},\"ms\":" + std::to_string(ms) + ",\"c\":" + jstr(st->cap_reason) + "}\n";
    } else {
        ev = "{\"k\":\"call_end\",\"i\":" + jstr(st->id) + ",\"s\":" + std::to_string(st->steps) + ",\"o\":\"return\",\"r\":null,\"ms\":" + std::to_string(ms) + ",\"c\":" + jstr(st->cap_reason) + "}\n";
    }
    if(g_w && g_w->is_open()) {
        *g_w << ev;
        g_bytes += ev.size();
        g_w->flush();
    }
    g_active--;
    if(g_active < 0) g_active = 0;
    delete st;
}

extern "C" void wk_close() {
    std::lock_guard<std::mutex> lk(g_mu);
    if(g_w) {
        g_w->flush();
        g_w->close();
        delete g_w;
        g_w = nullptr;
    }
}

static void __wk_at_exit() {
    wk_close();
}

static void __wk_init() {
    init();
    std::atexit(__wk_at_exit);
}

static int __wk_dummy = []() { __wk_init(); return 0; }();
 
