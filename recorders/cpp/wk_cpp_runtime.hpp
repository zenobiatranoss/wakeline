// c++ work by sora - https://github.com/q2hp0
#ifndef WAKELINE_CPP_RUNTIME_HPP
#define WAKELINE_CPP_RUNTIME_HPP

#include <string>
#include <vector>

struct WkState {
    std::string id;
    std::string name;
    int l0, l1;
    long long started;
    int depth;
    int steps;
    bool capped;
    std::string cap_reason;
    bool ended;
    bool threw;
};

#ifdef __cplusplus
extern "C" {
#endif

WkState* wk_enter(const char* name, int line0, int line1, void* args);
void wk_exc(WkState* st, void* ex);
void wk_end(WkState* st);
void wk_close();

#ifdef __cplusplus
}
#endif

#endif
//
