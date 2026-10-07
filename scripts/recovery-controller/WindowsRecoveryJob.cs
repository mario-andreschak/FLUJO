using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

// Source only until separately compiled/admitted. Own handles, never reopen a PID.
public static class WindowsRecoveryJob {
    const uint Suspended=4, NoWindow=0x08000000, UnicodeEnv=0x400, Extended=0x80000;
    const uint KillOnClose=0x2000, ActiveLimit=8, ProcessMemory=0x100, JobMemory=0x200;
    const int InformationAccounting=1, InformationExtended=9, InformationPort=7;
    const long OutputLimit=8L*1024*1024;
    public sealed class Birth {
        public int Ordinal; public long CorrelationPid; public long BornMs;
        public long? TerminalMs; public uint? TerminalMessage;
    }
    public sealed class Receipt {
        public string Outcome="failed-or-unknown"; public volatile string Failure;
        public bool AssignedBeforeResume, RootExitObserved, ActiveZeroObserved;
        public volatile bool StdoutClosed, StderrClosed;
        public bool ForcedJobTermination, JobClosureVerified;
        public uint RootExitCode, TotalProcesses, ActiveProcesses;
        public uint OriginalCorrelationPid;
        public long ElapsedMs, OutputBytes; public List<Birth> Births=new List<Birth>();
    }
    [StructLayout(LayoutKind.Sequential)] struct Security {
        public int Length; public IntPtr Descriptor; public int Inherit;
    }
    [StructLayout(LayoutKind.Sequential)] struct Startup {
        public int cb; public IntPtr reserved,desktop,title;
        public uint x,y,width,height,xChars,yChars,fill,flags;
        public ushort show,reserved2; public IntPtr reservedBytes,input,output,error;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupEx { public Startup Startup; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Pid,Tid; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long ProcessTime,JobTime; public uint Flags; public UIntPtr MinWorking,MaxWorking;
        public uint ActiveProcesses; public UIntPtr Affinity; public uint Priority,Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong Read,Write,Other,ReadBytes,WriteBytes,OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic; public IoCounters Io;
        public UIntPtr ProcessBytes,JobBytes,PeakProcessBytes,PeakJobBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct PortAssociation { public IntPtr Key,Port; }
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
        public long User,Kernel,PeriodUser,PeriodKernel;
        public uint PageFaults,Total,Active,Terminated;
    }
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObjectW(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,IntPtr data,uint bytes);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,out Accounting data,uint bytes,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool inJob);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateIoCompletionPort(IntPtr file,IntPtr port,UIntPtr key,uint threads);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetQueuedCompletionStatus(IntPtr port,out uint message,out UIntPtr key,out IntPtr correlation,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security security,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string file,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref UIntPtr bytes);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,UIntPtr attribute,IntPtr value,UIntPtr size,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application,StringBuilder command,IntPtr processSecurity,IntPtr threadSecurity,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    static void Check(bool okay,string action) { if(!okay) throw new Win32Exception(Marshal.GetLastWin32Error(),action); }
    static void Set<T>(IntPtr job,int kind,T data) where T:struct {
        IntPtr pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(T)));
        try { Marshal.StructureToPtr(data,pointer,false); Check(SetInformationJobObject(job,kind,pointer,(uint)Marshal.SizeOf(typeof(T))),"job policy/port"); }
        finally { Marshal.FreeHGlobal(pointer); }
    }
    static Accounting Sample(IntPtr job) {
        Accounting data; Check(QueryInformationJobObject(job,InformationAccounting,out data,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero),"job census"); return data;
    }
    public static string Quote(string value) {
        if(value.IndexOf('\0')>=0 || value.IndexOf('\r')>=0 || value.IndexOf('\n')>=0) throw new ArgumentException("Invalid argument");
        var text=new StringBuilder("\""); int slashes=0;
        foreach(char c in value) { if(c=='\\') { slashes++; continue; }
            text.Append('\\',c=='\"'?slashes*2+1:slashes); text.Append(c); slashes=0; }
        text.Append('\\',slashes*2); return text.Append('"').ToString();
    }
    public static Receipt Run(string exe,string[] args,string cwd,string environment,string outputDirectory) {
        return RunBounded(exe,args,cwd,environment,outputDirectory,1860000);
    }
    public static Receipt Qualify(string exe,string[] args,string cwd,string environment,string outputDirectory,int deadlineMs) {
        if(deadlineMs<1 || deadlineMs>10000)throw new ArgumentException("Qualification window must be at most10sec");
        return RunBounded(exe,args,cwd,environment,outputDirectory,deadlineMs);
    }
    static Receipt RunBounded(string exe,string[] args,string cwd,string environment,string outputDirectory,int deadlineMs) {
        var result=new Receipt(); var clock=Stopwatch.StartNew(); object gate=new object();
        Action<string> fail=reason=>{lock(gate){if(result.Failure==null)result.Failure=reason;}};
        IntPtr job=IntPtr.Zero,port=IntPtr.Zero,outRead=IntPtr.Zero,outWrite=IntPtr.Zero;
        IntPtr errRead=IntPtr.Zero,errWrite=IntPtr.Zero,input=IntPtr.Zero,attributes=IntPtr.Zero,handles=IntPtr.Zero,jobList=IntPtr.Zero,env=IntPtr.Zero;
        ProcessInfo original=new ProcessInfo(); FileStream stdout=null,stderr=null; Task outTask=null,errTask=null;
        SafeFileHandle outOwned=null,errOwned=null;
        var live=new Dictionary<long,Birth>(); bool resumed=false; int packets=0;
        try {
            if(IntPtr.Size!=8 || Environment.OSVersion.Platform!=PlatformID.Win32NT) throw new InvalidOperationException("Windows x64 only");
            job=CreateJobObjectW(IntPtr.Zero,null); Check(job!=IntPtr.Zero,"create original job");
            port=CreateIoCompletionPort(new IntPtr(-1),IntPtr.Zero,UIntPtr.Zero,1); Check(port!=IntPtr.Zero,"create completion port");
            Set(job,InformationPort,new PortAssociation {Key=new IntPtr(1),Port=port});
            Set(job,InformationExtended,new ExtendedLimit {Basic=new BasicLimit {Flags=KillOnClose|ActiveLimit|ProcessMemory|JobMemory,ActiveProcesses=16},ProcessBytes=new UIntPtr(2147483648UL),JobBytes=new UIntPtr(3221225472UL)});
            var security=new Security {Length=Marshal.SizeOf(typeof(Security)),Inherit=1};
            Check(CreatePipe(out outRead,out outWrite,ref security,0),"stdout pipe"); Check(SetHandleInformation(outRead,1,0),"stdout noninheritance");
            Check(CreatePipe(out errRead,out errWrite,ref security,0),"stderr pipe"); Check(SetHandleInformation(errRead,1,0),"stderr noninheritance");
            input=CreateFileW("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1),"NUL input");
            UIntPtr attributeBytes=UIntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref attributeBytes);
            attributes=Marshal.AllocHGlobal((int)attributeBytes.ToUInt64()); Check(InitializeProcThreadAttributeList(attributes,2,0,ref attributeBytes),"inheritance/job attribute list");
            handles=Marshal.AllocHGlobal(IntPtr.Size*3); Marshal.WriteIntPtr(handles,0,input); Marshal.WriteIntPtr(handles,IntPtr.Size,outWrite); Marshal.WriteIntPtr(handles,IntPtr.Size*2,errWrite);
            Check(UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x20002),handles,new UIntPtr((uint)(IntPtr.Size*3)),IntPtr.Zero,IntPtr.Zero),"explicit pipe handle list");
            // JOB_LIST (input attribute13) makes job membership atomic with creation.
            // No suspended child can be stranded outside the job if this controller dies.
            jobList=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobList,job);
            Check(UpdateProcThreadAttribute(attributes,0,new UIntPtr(0x2000d),jobList,new UIntPtr((uint)IntPtr.Size),IntPtr.Zero,IntPtr.Zero),"atomic original job list");
            var startup=new StartupEx {Startup=new Startup {cb=Marshal.SizeOf(typeof(StartupEx)),flags=0x100,input=input,output=outWrite,error=errWrite},Attributes=attributes};
            var command=new StringBuilder(Quote(exe)); foreach(string argument in args)command.Append(' ').Append(Quote(argument));
            env=Marshal.StringToHGlobalUni(environment);
            Check(CreateProcessW(exe,command,IntPtr.Zero,IntPtr.Zero,true,Suspended|NoWindow|UnicodeEnv|Extended,env,cwd,ref startup,out original),"create suspended original runner");
            result.OriginalCorrelationPid=original.Pid;
            bool inOriginalJob;Check(IsProcessInJob(original.Process,job,out inOriginalJob) && inOriginalJob,"original handle job membership before resume"); result.AssignedBeforeResume=true;
            CloseHandle(outWrite);outWrite=IntPtr.Zero;CloseHandle(errWrite);errWrite=IntPtr.Zero;CloseHandle(input);input=IntPtr.Zero;
            outOwned=new SafeFileHandle(outRead,true);outRead=IntPtr.Zero;stdout=new FileStream(outOwned,FileAccess.Read,4096,false);
            errOwned=new SafeFileHandle(errRead,true);errRead=IntPtr.Zero;stderr=new FileStream(errOwned,FileAccess.Read,4096,false);
            Func<FileStream,string,bool,Task> capture=(stream,file,isOut)=>Task.Run(()=>{
                try { using(var log=new FileStream(Path.Combine(outputDirectory,file),FileMode.CreateNew,FileAccess.Write,FileShare.Read)) {
                    var bytes=new byte[4096]; int read;
                    while((read=stream.Read(bytes,0,bytes.Length))>0) {
                        if(Interlocked.Add(ref result.OutputBytes,read)>OutputLimit) { fail("original-output-budget-exceeded"); return; }
                        log.Write(bytes,0,read);
                    } log.Flush(true); if(isOut)result.StdoutClosed=true;else result.StderrClosed=true;
                } } catch {fail("original-pipe-or-log-failed");}
            });
            outTask=capture(stdout,"driver.stdout.log",true);errTask=capture(stderr,"driver.stderr.log",false);
            Check(ResumeThread(original.Thread)!=0xffffffff,"resume admitted runner"); resumed=true;
            long failedAt=-1,rootExitAt=-1;
            while(true) {
                uint message; UIntPtr key; IntPtr correlation;
                bool received=GetQueuedCompletionStatus(port,out message,out key,out correlation,100);
                if(received) {
                    if(key.ToUInt64()!=1 || ++packets>4096)fail("completion-port-scope-or-packet-budget");
                    long pid=correlation.ToInt64();
                    if(message==6) {
                        if(result.Births.Count==0 && pid!=original.Pid)fail("first-birth-is-not-owned-original-runner");
                        if(live.ContainsKey(pid) || result.Births.Count>=16)fail("birth-census-refused");
                        else {var birth=new Birth {Ordinal=result.Births.Count+1,CorrelationPid=pid,BornMs=clock.ElapsedMilliseconds};live.Add(pid,birth);result.Births.Add(birth);}
                    } else if(message==7 || message==8) {
                        Birth birth; if(!live.TryGetValue(pid,out birth))fail("terminal-without-original-job-birth");
                        else {birth.TerminalMs=clock.ElapsedMilliseconds;birth.TerminalMessage=message;live.Remove(pid);}
                    } else if(message==4) result.ActiveZeroObserved=true;
                    else fail("unexpected-job-policy-notification-"+message);
                } else if(Marshal.GetLastWin32Error()!=258)fail("completion-port-read-failed");
                Accounting census=Sample(job);result.TotalProcesses=census.Total;result.ActiveProcesses=census.Active;
                if(census.Total>16)fail("total-birth-budget-exceeded");
                uint wait=WaitForSingleObject(original.Process,0);
                if(wait==0 && !result.RootExitObserved) {Check(GetExitCodeProcess(original.Process,out result.RootExitCode),"original exit code");result.RootExitObserved=true;rootExitAt=clock.ElapsedMilliseconds;if(result.RootExitCode!=0)fail("original-runner-nonzero");}
                else if(wait!=0 && wait!=258)fail("original-runner-wait-failed");
                if(clock.ElapsedMilliseconds>=deadlineMs)fail("outer-monotonic-deadline");
                if(result.RootExitObserved) {census=Sample(job);result.TotalProcesses=census.Total;result.ActiveProcesses=census.Active;}
                if(result.RootExitObserved && census.Active==0 && result.StdoutClosed && result.StderrClosed
                    && result.ActiveZeroObserved && live.Count==0 && result.Births.Count==census.Total) {result.JobClosureVerified=true;break;}
                if(rootExitAt>=0 && clock.ElapsedMilliseconds-rootExitAt>=5000)fail("original-job-or-pipes-closure-unverified");
                if(result.Failure!=null && failedAt<0) {failedAt=clock.ElapsedMilliseconds;result.ForcedJobTermination=true;Check(TerminateJobObject(job,1),"terminate only original owned job after failure");}
                if(failedAt>=0 && clock.ElapsedMilliseconds-failedAt>=10000)break;
            }
        } catch(Exception error) {
            fail("controller-native-failure-"+error.GetType().Name);
        } finally {
            // Assignment refusal leaves an unstarted original handle, never a running orphan.
            if(original.Process!=IntPtr.Zero && (!resumed || !result.JobClosureVerified)) {
                result.ForcedJobTermination=true;
                if(result.AssignedBeforeResume && job!=IntPtr.Zero)TerminateJobObject(job,1);
                else TerminateProcess(original.Process,1);
                if(WaitForSingleObject(original.Process,5000)==0) {result.RootExitObserved=true;GetExitCodeProcess(original.Process,out result.RootExitCode);}
            }
            if(job!=IntPtr.Zero)CloseHandle(job); // KILL_ON_JOB_CLOSE is fail-closed, never success evidence.
            if(outTask!=null && !outTask.Wait(5000))fail("stdout-original-closure-unverified");
            if(errTask!=null && !errTask.Wait(5000))fail("stderr-original-closure-unverified");
            if(stdout!=null)stdout.Dispose();else if(outOwned!=null)outOwned.Dispose();
            if(stderr!=null)stderr.Dispose();else if(errOwned!=null)errOwned.Dispose();
            foreach(IntPtr handle in new[]{outRead,outWrite,errRead,errWrite,input,original.Thread,original.Process,port})
                if(handle!=IntPtr.Zero && handle!=new IntPtr(-1))CloseHandle(handle);
            if(attributes!=IntPtr.Zero){DeleteProcThreadAttributeList(attributes);Marshal.FreeHGlobal(attributes);}
            if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);if(jobList!=IntPtr.Zero)Marshal.FreeHGlobal(jobList);if(env!=IntPtr.Zero)Marshal.FreeHGlobal(env);
            result.ElapsedMs=clock.ElapsedMilliseconds;
            if(result.Failure==null && result.AssignedBeforeResume && result.RootExitObserved && result.RootExitCode==0
                && result.StdoutClosed && result.StderrClosed && result.JobClosureVerified && !result.ForcedJobTermination)result.Outcome="original-job-and-pipes-closed";
        }
        return result;
    }
}
