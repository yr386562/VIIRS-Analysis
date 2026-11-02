// VIIRS_ANALYZER.exe: starts the viewer (VIIRS · Analyze. Study. Observe.: TEMPER and LIGHT ROAST) from the folder it sits in and opens it in the browser.
//
// The folder (built by build_standalone.py) holds everything it runs: runtime\ (Python and the packages the viewer
// uses), app\ (the viewer) and this launcher. Nothing is installed and nothing goes to the network.
//
//   VIIRS_ANALYZER.exe                  start (or, when it is already running, just open it)
//   VIIRS_ANALYZER.exe --choose-data    choose the data folders again
//   VIIRS_ANALYZER.exe --port 8770      another port (default 8768; the next free one when it is taken)
//   VIIRS_ANALYZER.exe --no-browser     start without opening the browser
//
// The data folders: TEMPER's (the folder of countries, VIIRS_NIGHT_SWIR) and LIGHT ROAST's (VIIRS_NIGHT_DNB). They
// come from app\config.json; the first time, from a data\ folder beside VIIRS_ANALYZER.exe if there is one, else the user
// chooses them, and they are saved there.
//
// Built with the C# compiler that ships with Windows (.NET Framework 4):
//   csc /target:exe /out:VIIRS_ANALYZER.exe /win32icon:..\static\brand\viirs.ico /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll VIIRS_ANALYZER.cs
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

static class Launcher
{
    const int DefaultPort = 8768;
    const string Name = "VIIRS: Analyze. Study. Observe.", Exe = "VIIRS_ANALYZER.exe";

    [STAThread]
    static int Main(string[] args)
    {
        string home = AppDomain.CurrentDomain.BaseDirectory;
        string python = Path.Combine(home, "runtime", "python.exe");
        string app = Path.Combine(home, "app");
        string server = Path.Combine(app, "server.py");
        bool choose = Array.IndexOf(args, "--choose-data") >= 0, browser = Array.IndexOf(args, "--no-browser") < 0;
        int port = DefaultPort;
        int at = Array.IndexOf(args, "--port");
        if (at >= 0 && at + 1 < args.Length) int.TryParse(args[at + 1], out port);
        Console.Title = Name + " - TEMPER, LIGHT ROAST";
        if (!File.Exists(python) || !File.Exists(server))
            return Fail("This folder is incomplete: runtime\\python.exe or app\\server.py is missing. Copy the whole folder.");

        // Already running here: open it.
        string url = "http://127.0.0.1:" + port;
        if (!choose && IsViewer(url))
        {
            Console.WriteLine(Name + " is already running at " + url);
            if (browser) Open(url);
            return 0;
        }
        while (!PortFree(port) && port < DefaultPort + 20) port++;
        url = "http://127.0.0.1:" + port;

        if (!DataFolders(home, Path.Combine(app, "config.json"), choose))
            return Fail("No data folder was chosen. Start " + Exe + " again to choose one.");

        var start = new ProcessStartInfo(python, "-u \"" + server + "\" --port " + port)
        {
            WorkingDirectory = app,
            UseShellExecute = false,
        };
        // Only what is in this folder: no Python, GDAL or PROJ settings from the computer.
        foreach (string name in new[] { "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONUSERBASE", "PROJ_LIB", "PROJ_DATA", "GDAL_DATA", "GDAL_DRIVER_PATH", "TEMPER_DATA_ROOT", "TEMPER_LR_ROOT" })
            start.EnvironmentVariables.Remove(name);
        start.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8";
        start.EnvironmentVariables["PYTHONUTF8"] = "1";
        Process viewer = Process.Start(start);
        Job.Hold(viewer);   // the viewer stops with this window, however it closes

        Console.WriteLine("Starting " + Name + " at " + url + " ...");
        for (int i = 0; i < 240 && !IsViewer(url); i++)
        {
            if (viewer.HasExited)
                return Fail("The viewer stopped while starting (exit code " + viewer.ExitCode + "). The messages above say why.");
            Thread.Sleep(250);
        }
        if (!IsViewer(url))
            return Fail("The viewer did not answer at " + url + " within a minute.");
        Console.WriteLine();
        Console.WriteLine(Name + " is running at " + url);
        Console.WriteLine("Keep this window open while you use it; close it to stop " + Name + ".");
        Console.WriteLine();
        if (browser) Open(url);
        viewer.WaitForExit();
        return viewer.ExitCode;
    }

    // The data folders in app\config.json: kept when they exist, else found beside the launcher, else chosen.
    static bool DataFolders(string home, string configPath, bool choose)
    {
        var json = new JavaScriptSerializer();
        Dictionary<string, object> config;
        try { config = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(configPath)); }
        catch (Exception) { config = new Dictionary<string, object>(); }
        if (config == null) config = new Dictionary<string, object>();
        string swir = config.ContainsKey("data_root") ? config["data_root"] as string : null;
        string dnb = config.ContainsKey("lightroast_root") ? config["lightroast_root"] as string : null;
        if (!choose && swir != null && Directory.Exists(swir)) return true;

        swir = null;
        if (!choose)
            foreach (string candidate in new[] { Path.Combine(home, "data", "VIIRS_NIGHT_SWIR"), Path.Combine(home, "VIIRS_NIGHT_SWIR"), Path.Combine(home, "..", "VIIRS_NIGHT_SWIR") })
                if (Directory.Exists(candidate)) { swir = Path.GetFullPath(candidate); break; }
        if (swir == null)
        {
            MessageBox.Show("בחרו את תיקיית הנתונים של TEMPER: התיקייה שבתוכה תיקיית מדינה לכל מדינה (VIIRS_NIGHT_SWIR).\n\n" +
                            "Choose TEMPER's data folder: the folder with one folder per country (VIIRS_NIGHT_SWIR).", Name);
            swir = Choose("TEMPER: the folder of countries (VIIRS_NIGHT_SWIR)");
            if (swir == null) return false;
        }
        string sibling = Path.Combine(Path.GetDirectoryName(swir) ?? swir, "VIIRS_NIGHT_DNB");
        if (Directory.Exists(sibling)) dnb = sibling;
        else if (dnb == null || !Directory.Exists(dnb))
        {
            var answer = MessageBox.Show("יש גם נתוני LIGHT ROAST (אורות לילה, VIIRS_NIGHT_DNB)? בחרו את התיקייה, או ביטול בלעדיהם.\n\n" +
                                         "Is there LIGHT ROAST data (night lights, VIIRS_NIGHT_DNB)? Choose its folder, or Cancel to go without.", Name, MessageBoxButtons.OKCancel);
            dnb = answer == DialogResult.OK ? Choose("LIGHT ROAST: the folder of countries (VIIRS_NIGHT_DNB)") : null;
        }
        config["data_root"] = swir;
        if (dnb != null) config["lightroast_root"] = dnb; else config.Remove("lightroast_root");
        File.WriteAllText(configPath, json.Serialize(config));
        Console.WriteLine("Data: " + swir + (dnb != null ? "\nLIGHT ROAST data: " + dnb : ""));
        return true;
    }

    static string Choose(string title)
    {
        using (var dialog = new FolderBrowserDialog { Description = title, ShowNewFolderButton = false })
            return dialog.ShowDialog() == DialogResult.OK ? dialog.SelectedPath : null;
    }

    // The viewer answers its health check (and says it is offline).
    static bool IsViewer(string url)
    {
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(url + "/api/health");
            request.Timeout = 1500;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream()))
                return reader.ReadToEnd().Contains("\"offline\": true");
        }
        catch (Exception) { return false; }
    }

    static bool PortFree(int port)
    {
        try
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException) { return false; }
    }

    // As an app window (no tabs or address bar) in Edge or Chrome; else the default browser.
    static void Open(string url)
    {
        string pf = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string pf86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        foreach (string exe in new[] {
            Path.Combine(pf86, @"Microsoft\Edge\Application\msedge.exe"), Path.Combine(pf, @"Microsoft\Edge\Application\msedge.exe"),
            Path.Combine(pf, @"Google\Chrome\Application\chrome.exe"), Path.Combine(pf86, @"Google\Chrome\Application\chrome.exe"),
            Path.Combine(local, @"Google\Chrome\Application\chrome.exe") })
        {
            if (File.Exists(exe))
            {
                Process.Start(exe, "--app=" + url + " --window-size=1600,1000");
                return;
            }
        }
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }

    // A job object that ends its processes when this launcher ends: closed, killed or crashed.
    static class Job
    {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll")] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, int size);
        [DllImport("kernel32.dll")] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

        [StructLayout(LayoutKind.Sequential)]
        struct BasicLimits
        {
            public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
            public int LimitFlags;
            public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
            public int ActiveProcessLimit;
            public IntPtr Affinity;
            public int PriorityClass, SchedulingClass;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct ExtendedLimits
        {
            public BasicLimits Basic;
            public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
            public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
        }

        static IntPtr handle;   // kept open for the launcher's lifetime; the system closes it when the launcher ends

        public static void Hold(Process process)
        {
            try
            {
                if (handle == IntPtr.Zero)
                {
                    handle = CreateJobObject(IntPtr.Zero, null);
                    var limits = new ExtendedLimits();
                    limits.Basic.LimitFlags = 0x2000;   // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    SetInformationJobObject(handle, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits)));   // 9: extended limits
                }
                AssignProcessToJobObject(handle, process.Handle);
            }
            catch (Exception) { }   // without it, closing the window still stops the viewer (they share the console)
        }
    }

    static int Fail(string message)
    {
        Console.WriteLine();
        Console.WriteLine(message);
        Console.WriteLine("Press Enter to close.");
        Console.ReadLine();
        return 1;
    }
}
