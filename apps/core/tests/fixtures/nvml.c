/* External NVML ABI fixture: driver retains an allocation after process exit. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdint.h>
typedef struct { unsigned pid; unsigned long long bytes; unsigned gpu, compute; } Process;
int nvmlInit_v2(void) { return 0; }
int nvmlShutdown(void) { return 0; }
int nvmlDeviceGetCount_v2(unsigned *n) {
    const char *path=getenv("FIXTURE_NVML_STATE"); FILE *f=path ? fopen(path,"r") : NULL;
    char text[64]={0}; if(f) { fgets(text,sizeof(text),f); fclose(f); }
    if(strcmp(text,"collector failure")==0) return 999;
    *n=1; return 0;
}
int nvmlDeviceGetHandleByIndex_v2(unsigned i, void **d) { *d=(void*)(uintptr_t)1; return i ? 2 : 0; }
int nvmlDeviceGetUUID(void *d, char *s, unsigned n) { snprintf(s,n,"GPU-fixture"); return 0; }
int nvmlDeviceGetComputeRunningProcesses_v3(void *d, unsigned *n, Process *p) {
    const char *path=getenv("FIXTURE_NVML_STATE");
    FILE *f=path ? fopen(path,"r") : NULL;
    unsigned pid=0; double until=0; struct timespec now;
    if (f) { if(fscanf(f,"%u %lf",&pid,&until)!=2) pid=0; fclose(f); }
    clock_gettime(CLOCK_REALTIME,&now);
    if (!pid || now.tv_sec+now.tv_nsec/1e9 >= until) { *n=0; return 0; }
    if (!p || !*n) { *n=1; return 7; }
    *n=1; p[0]=(Process){pid,1048576,0,0}; return 0;
}
typedef struct { unsigned gpu, memory; } Utilisation;
int nvmlDeviceGetUtilizationRates(void *d, Utilisation *u) {
    const char *path=getenv("FIXTURE_NVML_STATE");
    FILE *f=path ? fopen(path,"r") : NULL;
    if (f) { fclose(f); return 999; }
    *u=(Utilisation){42,10}; return 0;
}
int nvmlSystemGetDriverVersion(char *s, unsigned n) { snprintf(s,n,"fixture-driver-changed"); return 0; }
typedef struct { unsigned version; unsigned long long total, reserved, free, used; } Memory;
int nvmlDeviceGetMemoryInfo_v2(void *d, Memory *m) {
    const char *path=getenv("FIXTURE_NVML_STATE"); FILE *f=path ? fopen(path,"r") : NULL;
    if (f) { fclose(f); return 999; }
    *m=(Memory){m->version,1073741824,0,1006632960,67108864}; return 0;
}
