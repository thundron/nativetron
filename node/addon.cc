#include <node_api.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>

extern "C" {
void nt_init(void);
void nt_add_init(const uint8_t *js, size_t n);
void nt_set_title(const uint8_t *s, size_t n);
void nt_set_size(int32_t w, int32_t h);
void nt_set_html(const uint8_t *s, size_t n);
void nt_eval(const uint8_t *js, size_t n);
void nt_on_message(void (*cb)(const uint8_t *, size_t, void *), void *ctx);
void nt_send_ops(const uint8_t *b, size_t n);
int nt_pump(void);
void nt_activate(void);
void nt_terminate(void);
}

namespace {

napi_env g_env = nullptr;
napi_ref g_on_message = nullptr;

std::string utf8_arg(napi_env env, napi_value v) {
  size_t len = 0;
  napi_get_value_string_utf8(env, v, nullptr, 0, &len);
  std::string s(len, '\0');
  napi_get_value_string_utf8(env, v, s.data(), len + 1, &len);
  s.resize(len);
  return s;
}

void deliver(const uint8_t *p, size_t n, void *) {
  if (g_env == nullptr || g_on_message == nullptr) {
    return;
  }
  napi_handle_scope scope;
  if (napi_open_handle_scope(g_env, &scope) != napi_ok) {
    return;
  }
  napi_value fn = nullptr;
  napi_value undef = nullptr;
  napi_value arg = nullptr;
  napi_get_reference_value(g_env, g_on_message, &fn);
  napi_get_undefined(g_env, &undef);
  if (fn != nullptr &&
      napi_create_string_utf8(g_env, reinterpret_cast<const char *>(p), n,
                              &arg) == napi_ok) {
    napi_value result = nullptr;
    napi_call_function(g_env, undef, fn, 1, &arg, &result);
    bool pending = false;
    if (napi_is_exception_pending(g_env, &pending) == napi_ok && pending) {
      napi_value err = nullptr;
      napi_get_and_clear_last_exception(g_env, &err);
      napi_fatal_exception(g_env, err);
    }
  }
  napi_close_handle_scope(g_env, scope);
}

#define ARGS(count)                                                            \
  size_t argc = (count);                                                       \
  napi_value argv[(count)];                                                    \
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr)

napi_value Init(napi_env env, napi_callback_info info) {
  g_env = env;
  nt_init();
  nt_on_message(deliver, nullptr);
  return nullptr;
}

napi_value AddInit(napi_env env, napi_callback_info info) {
  ARGS(1);
  std::string s = utf8_arg(env, argv[0]);
  nt_add_init(reinterpret_cast<const uint8_t *>(s.data()), s.size());
  return nullptr;
}

napi_value SetTitle(napi_env env, napi_callback_info info) {
  ARGS(1);
  std::string s = utf8_arg(env, argv[0]);
  nt_set_title(reinterpret_cast<const uint8_t *>(s.data()), s.size());
  return nullptr;
}

napi_value SetSize(napi_env env, napi_callback_info info) {
  ARGS(2);
  int32_t w = 0, h = 0;
  napi_get_value_int32(env, argv[0], &w);
  napi_get_value_int32(env, argv[1], &h);
  nt_set_size(w, h);
  return nullptr;
}

napi_value SetHtml(napi_env env, napi_callback_info info) {
  ARGS(1);
  std::string s = utf8_arg(env, argv[0]);
  nt_set_html(reinterpret_cast<const uint8_t *>(s.data()), s.size());
  return nullptr;
}

napi_value Eval(napi_env env, napi_callback_info info) {
  ARGS(1);
  std::string s = utf8_arg(env, argv[0]);
  nt_eval(reinterpret_cast<const uint8_t *>(s.data()), s.size());
  return nullptr;
}

napi_value OnMessage(napi_env env, napi_callback_info info) {
  ARGS(1);
  if (g_on_message != nullptr) {
    napi_delete_reference(env, g_on_message);
    g_on_message = nullptr;
  }
  napi_create_reference(env, argv[0], 1, &g_on_message);
  return nullptr;
}

napi_value ApplyBatch(napi_env env, napi_callback_info info) {
  ARGS(1);
  void *data = nullptr;
  size_t len = 0;
  bool is_ta = false;
  napi_is_typedarray(env, argv[0], &is_ta);
  if (is_ta) {
    napi_typedarray_type type;
    napi_value buf;
    size_t off = 0;
    napi_get_typedarray_info(env, argv[0], &type, &len, &data, &buf, &off);
  } else {
    napi_get_arraybuffer_info(env, argv[0], &data, &len);
  }
  if (data != nullptr && len > 0) {
    nt_send_ops(static_cast<const uint8_t *>(data), len);
  }
  return nullptr;
}

napi_value Pump(napi_env env, napi_callback_info info) {
  napi_value out = nullptr;
  napi_get_boolean(env, nt_pump() == 1, &out);
  return out;
}

napi_value Activate(napi_env env, napi_callback_info info) {
  nt_activate();
  return nullptr;
}

napi_value Terminate(napi_env env, napi_callback_info info) {
  nt_terminate();
  return nullptr;
}

napi_value Register(napi_env env, napi_value exports) {
  const struct {
    const char *name;
    napi_callback fn;
  } entries[] = {
      {"init", Init},          {"addInit", AddInit},
      {"setTitle", SetTitle},  {"setSize", SetSize},
      {"setHtml", SetHtml},    {"eval", Eval},
      {"onMessage", OnMessage},{"applyBatch", ApplyBatch},
      {"pump", Pump},          {"activate", Activate},
      {"terminate", Terminate},
  };
  for (const auto &e : entries) {
    napi_value fn = nullptr;
    napi_create_function(env, e.name, NAPI_AUTO_LENGTH, e.fn, nullptr, &fn);
    napi_set_named_property(env, exports, e.name, fn);
  }
  return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Register)
