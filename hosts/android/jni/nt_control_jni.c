// JNI bridge for dev.nativetron.app.NativeControl. Only JNI_OnLoad is
// exported (see exports.map); natives are bound with RegisterNatives so the
// scriptc runtime symbols stay private to libntcontrol.so.
#include <jni.h>
#include <stdint.h>
#include <stdlib.h>

#include "nt_control_host.h"

static jint status_of(JNIEnv *env, jintArray status, jint value) {
  if (status && (*env)->GetArrayLength(env, status) >= 1) (*env)->SetIntArrayRegion(env, status, 0, 1, &value);
  return value;
}

static jbyteArray to_java(JNIEnv *env, uint8_t *bytes, size_t length, jintArray status) {
  jbyteArray array = (*env)->NewByteArray(env, (jsize)length);
  if (array) (*env)->SetByteArrayRegion(env, array, 0, (jsize)length, (const jbyte *)bytes);
  nt_host_free(bytes);
  if (!array) { (*env)->ExceptionClear(env); status_of(env, status, NT_HOST_NO_MEMORY); return NULL; }
  status_of(env, status, NT_HOST_OK);
  return array;
}

// Copies Java bytes into a native buffer before entering scriptc: no JNI
// critical section or pinned array is held across the library call.
static uint8_t *from_java(JNIEnv *env, jbyteArray input, size_t *length, int *status) {
  *status = NT_HOST_OK;
  *length = 0;
  if (!input) { *status = NT_HOST_REFUSED; return NULL; }
  jsize size = (*env)->GetArrayLength(env, input);
  if ((size_t)size > NT_HOST_MAX_FRAME) { *status = NT_HOST_TOO_LARGE; return NULL; }
  uint8_t *bytes = malloc(size ? (size_t)size : 1);
  if (!bytes) { *status = NT_HOST_NO_MEMORY; return NULL; }
  if (size) (*env)->GetByteArrayRegion(env, input, 0, size, (jbyte *)bytes);
  *length = (size_t)size;
  return bytes;
}

static jint native_open(JNIEnv *env, jclass type) { (void)env; (void)type; return nt_host_open(); }
static jint native_close(JNIEnv *env, jclass type) { (void)env; (void)type; return nt_host_close(); }
static jint native_collect(JNIEnv *env, jclass type) { (void)env; (void)type; return nt_host_collect(); }

static jbyteArray native_command(JNIEnv *env, jclass type, jlong topic, jbyteArray payload, jintArray status) {
  (void)type;
  if (topic < 0 || topic > 0xffffffffLL) { status_of(env, status, NT_HOST_REFUSED); return NULL; }
  size_t length; int copied;
  uint8_t *bytes = from_java(env, payload, &length, &copied);
  if (copied != NT_HOST_OK) { status_of(env, status, copied); return NULL; }
  uint8_t *frame = NULL; size_t frame_length = 0;
  int result = nt_host_command((uint32_t)topic, bytes, length, &frame, &frame_length);
  free(bytes);
  if (result != NT_HOST_OK) { status_of(env, status, result); return NULL; }
  return to_java(env, frame, frame_length, status);
}

static jbyteArray native_receive(JNIEnv *env, jclass type, jbyteArray frame, jintArray status) {
  (void)type;
  size_t length; int copied;
  uint8_t *bytes = from_java(env, frame, &length, &copied);
  if (copied != NT_HOST_OK) { status_of(env, status, copied); return NULL; }
  uint8_t *routed = NULL; size_t routed_length = 0;
  int result = nt_host_receive(bytes, length, &routed, &routed_length);
  free(bytes);
  if (result != NT_HOST_OK) { status_of(env, status, result); return NULL; }
  return to_java(env, routed, routed_length, status);
}

static jbyteArray native_panic(JNIEnv *env, jclass type) {
  (void)type;
  size_t length;
  const uint8_t *bytes = nt_host_panic(&length);
  if (!bytes) return NULL;
  jbyteArray array = (*env)->NewByteArray(env, (jsize)length);
  if (array) (*env)->SetByteArrayRegion(env, array, 0, (jsize)length, (const jbyte *)bytes);
  else (*env)->ExceptionClear(env);
  return array;
}

static const JNINativeMethod methods[] = {
  { "nativeOpen", "()I", (void *)native_open },
  { "nativeClose", "()I", (void *)native_close },
  { "nativeCollect", "()I", (void *)native_collect },
  { "nativeCommand", "(J[B[I)[B", (void *)native_command },
  { "nativeReceive", "([B[I)[B", (void *)native_receive },
  { "nativePanic", "()[B", (void *)native_panic },
};

JNIEXPORT jint JNI_OnLoad(JavaVM *vm, void *reserved) {
  (void)reserved;
  JNIEnv *env;
  if ((*vm)->GetEnv(vm, (void **)&env, JNI_VERSION_1_6) != JNI_OK) return JNI_ERR;
  jclass type = (*env)->FindClass(env, "dev/nativetron/app/NativeControl");
  if (!type) return JNI_ERR;
  jint result = (*env)->RegisterNatives(env, type, methods, (jint)(sizeof methods / sizeof methods[0]));
  (*env)->DeleteLocalRef(env, type);
  return result == JNI_OK ? JNI_VERSION_1_6 : JNI_ERR;
}
