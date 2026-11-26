using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace ComfyUILauncher
{
    public enum ComfyStatus
    {
        Stopped,
        Starting,
        Running
    }

    static class Program
    {
        private static NotifyIcon trayIcon;
        private static ToolStripMenuItem statusItem;
        private static ToolStripMenuItem vaultStatusItem;
        private static ToolStripMenuItem vaultMenu;
        private static ToolStripMenuItem openVaultItem;
        private static ToolStripMenuItem startVaultItem;
        private static ToolStripMenuItem restartVaultItem;
        private static ToolStripMenuItem stopVaultItem;
        private static ToolStripMenuItem comfyMenu;
        private static ToolStripMenuItem openComfyItem;
        private static ToolStripMenuItem startComfyItem;
        private static ToolStripMenuItem restartComfyItem;
        private static ToolStripMenuItem stopComfyItem;
        private static ToolStripMenuItem startAllItem;
        private static ToolStripMenuItem restartAllItem;
        private static ToolStripMenuItem stopAllItem;
        private static ToolStripMenuItem langToggleItem;
        private static ToolStripMenuItem exitItem;
        private static System.Windows.Forms.Timer statusTimer;
        private static Icon currentIcon;
        private static ComfyStatus lastStatus = (ComfyStatus)(-1);

        private static readonly string BaseDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        private static readonly string BatPath = Path.Combine(BaseDir, "run_nvidia_gpu.bat");
        private static readonly string PythonExe = Path.Combine(BaseDir, @"python_embeded\python.exe");
        private static readonly string VaultDir = Path.Combine(BaseDir, "ComfyVault");
        private static readonly string LangConfigPath = Path.Combine(VaultDir, @"data\launcher_lang.txt");
        private static bool isChinese = DetectInitialChinese();
        private static readonly int ComfyPort = DetectComfyPort();
        private static readonly string WebUrl = "http://127.0.0.1:" + ComfyPort + "/";
        private static readonly string SystemStatsUrl = "http://127.0.0.1:" + ComfyPort + "/system_stats";
        private static readonly string VaultUrl = "http://127.0.0.1:8189/";
        private static readonly string VaultHealthUrl = "http://127.0.0.1:8189/api/health";

        private static string T(string zh, string en)
        {
            return isChinese ? zh : en;
        }

        private static bool DetectInitialChinese()
        {
            try
            {
                if (File.Exists(LangConfigPath))
                {
                    string v = File.ReadAllText(LangConfigPath).Trim().ToLowerInvariant();
                    if (v == "en") return false;
                    if (v == "zh") return true;
                }
            }
            catch { }
            return CultureInfo.CurrentUICulture.TwoLetterISOLanguageName.Equals("zh", StringComparison.OrdinalIgnoreCase);
        }

        private static void ToggleLanguage()
        {
            isChinese = !isChinese;
            try
            {
                string dir = Path.GetDirectoryName(LangConfigPath);
                if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
                File.WriteAllText(LangConfigPath, isChinese ? "zh" : "en");
            }
            catch { }
            ApplyMenuTexts();
            RefreshStatus();
        }

        private static void ApplyMenuTexts()
        {
            vaultMenu.Text = T("ComfyVault 资产库 (8189)", "ComfyVault (8189)");
            openVaultItem.Text = T("打开网页 (http://127.0.0.1:8189)", "Open Web UI (http://127.0.0.1:8189)");
            startVaultItem.Text = T("启动 ComfyVault", "Start ComfyVault");
            restartVaultItem.Text = T("重启 ComfyVault", "Restart ComfyVault");
            stopVaultItem.Text = T("停止 ComfyVault", "Stop ComfyVault");

            comfyMenu.Text = T("ComfyUI 主程序 (" + ComfyPort + ")", "ComfyUI (" + ComfyPort + ")");
            openComfyItem.Text = T("打开网页 (http://127.0.0.1:" + ComfyPort + ")", "Open Web UI (http://127.0.0.1:" + ComfyPort + ")");
            startComfyItem.Text = T("启动 ComfyUI", "Start ComfyUI");
            restartComfyItem.Text = T("重启 ComfyUI", "Restart ComfyUI");
            stopComfyItem.Text = T("停止 ComfyUI", "Stop ComfyUI");

            startAllItem.Text = T("启动全部 (ComfyUI + ComfyVault)", "Start All (ComfyUI + ComfyVault)");
            restartAllItem.Text = T("重启全部服务", "Restart All Services");
            stopAllItem.Text = T("停止全部服务", "Stop All Services");
            langToggleItem.Text = T("Language: English", "语言：切换为中文");
            exitItem.Text = T("退出启动器", "Exit Launcher");
        }

        private static int DetectComfyPort()
        {
            try
            {
                if (File.Exists(BatPath))
                {
                    string txt = File.ReadAllText(BatPath);
                    Match m = Regex.Match(txt, @"--port(?:=|\s+)(\d+)", RegexOptions.IgnoreCase);
                    int p;
                    if (m.Success && int.TryParse(m.Groups[1].Value, out p) && p > 0 && p < 65536)
                        return p;
                }
            }
            catch { }
            return 8188;
        }

        private static bool pendingOpenComfy = false;
        private static bool pendingOpenVault = false;

        [DllImport("user32.dll", SetLastError = true)]
        private static extern bool DestroyIcon(IntPtr hIcon);

        [STAThread]
        static void Main()
        {
            bool createdNew;
            using (Mutex mutex = new Mutex(true, "ComfyUI_Vault_Launcher_SingleInstance", out createdNew))
            {
                if (!createdNew)
                {
                    // Already running: just open both web UIs if ready
                    OpenUrl(VaultUrl);
                    OpenUrl(WebUrl);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);

                ContextMenuStrip menu = new ContextMenuStrip();

                statusItem = new ToolStripMenuItem("ComfyUI: ...");
                statusItem.Enabled = false;
                vaultStatusItem = new ToolStripMenuItem("ComfyVault: ...");
                vaultStatusItem.Enabled = false;

                // ComfyVault independent submenu
                vaultMenu = new ToolStripMenuItem();
                openVaultItem = new ToolStripMenuItem("", null, (s, e) => OpenUrl(VaultUrl));
                startVaultItem = new ToolStripMenuItem("", null, (s, e) => { StartVault(true); RefreshStatus(); });
                restartVaultItem = new ToolStripMenuItem("", null, (s, e) => ThreadPool.QueueUserWorkItem(_ => RestartVault()));
                stopVaultItem = new ToolStripMenuItem("", null, (s, e) => { StopVault(true); RefreshStatus(); });
                vaultMenu.DropDownItems.Add(openVaultItem);
                vaultMenu.DropDownItems.Add(new ToolStripSeparator());
                vaultMenu.DropDownItems.Add(startVaultItem);
                vaultMenu.DropDownItems.Add(restartVaultItem);
                vaultMenu.DropDownItems.Add(stopVaultItem);

                // ComfyUI independent submenu
                comfyMenu = new ToolStripMenuItem();
                openComfyItem = new ToolStripMenuItem("", null, (s, e) => OpenUrl(WebUrl));
                startComfyItem = new ToolStripMenuItem("", null, (s, e) => { StartComfy(true); RefreshStatus(); });
                restartComfyItem = new ToolStripMenuItem("", null, (s, e) => ThreadPool.QueueUserWorkItem(_ => RestartComfy()));
                stopComfyItem = new ToolStripMenuItem("", null, (s, e) => { StopComfy(true); RefreshStatus(); });
                comfyMenu.DropDownItems.Add(openComfyItem);
                comfyMenu.DropDownItems.Add(new ToolStripSeparator());
                comfyMenu.DropDownItems.Add(startComfyItem);
                comfyMenu.DropDownItems.Add(restartComfyItem);
                comfyMenu.DropDownItems.Add(stopComfyItem);

                // Combined quick actions
                startAllItem = new ToolStripMenuItem("", null, (s, e) => StartAll(true));
                restartAllItem = new ToolStripMenuItem("", null, (s, e) => ThreadPool.QueueUserWorkItem(_ => RestartAll()));
                stopAllItem = new ToolStripMenuItem("", null, (s, e) => StopAll(true));
                langToggleItem = new ToolStripMenuItem("", null, (s, e) => ToggleLanguage());
                exitItem = new ToolStripMenuItem("", null, (s, e) => ExitApp());

                ApplyMenuTexts();

                menu.Items.Add(statusItem);
                menu.Items.Add(vaultStatusItem);
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add(vaultMenu);
                menu.Items.Add(comfyMenu);
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add(startAllItem);
                menu.Items.Add(restartAllItem);
                menu.Items.Add(stopAllItem);
                menu.Items.Add(new ToolStripSeparator());
                menu.Items.Add(langToggleItem);
                menu.Items.Add(exitItem);

                trayIcon = new NotifyIcon();
                trayIcon.ContextMenuStrip = menu;
                trayIcon.Visible = true;
                trayIcon.MouseClick += TrayIconMouseClick;

                statusTimer = new System.Windows.Forms.Timer();
                statusTimer.Interval = 2000;
                statusTimer.Tick += (s, e) => RefreshStatus();
                statusTimer.Start();

                // Launch both services automatically on startup and open both browser tabs when ready
                StartAll(true);
                RefreshStatus();

                Application.Run();
            }
        }

        private static void TrayIconMouseClick(object sender, MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Left)
            {
                OpenUrl(VaultUrl);
            }
        }

        private static void RefreshStatus()
        {
            ComfyStatus status = GetComfyStatus();
            bool vaultRunning = IsHttpResponding(VaultHealthUrl);

            statusItem.Text = "ComfyUI: " + GetStatusLabel(status);
            vaultStatusItem.Text = "ComfyVault: " + (vaultRunning ? T("运行中 (8189)", "Running (8189)") : T("已停止", "Stopped"));

            startVaultItem.Enabled = !vaultRunning;
            restartVaultItem.Enabled = vaultRunning;
            stopVaultItem.Enabled = vaultRunning;

            startComfyItem.Enabled = (status == ComfyStatus.Stopped);
            restartComfyItem.Enabled = (status != ComfyStatus.Stopped);
            stopComfyItem.Enabled = (status != ComfyStatus.Stopped);

            startAllItem.Enabled = (status == ComfyStatus.Stopped) || !vaultRunning;
            restartAllItem.Enabled = (status != ComfyStatus.Stopped) || vaultRunning;
            stopAllItem.Enabled = (status != ComfyStatus.Stopped) || vaultRunning;

            if (status != lastStatus)
            {
                lastStatus = status;
                SetTrayIcon(status);
            }

            trayIcon.Text = string.Format("ComfyUI: {0} | Vault: {1}", GetStatusLabel(status), vaultRunning ? T("运行中", "Running") : T("已停止", "Stopped"));

            if (pendingOpenVault && vaultRunning)
            {
                pendingOpenVault = false;
                OpenUrl(VaultUrl);
            }
            if (pendingOpenComfy && status == ComfyStatus.Running)
            {
                pendingOpenComfy = false;
                OpenUrl(WebUrl);
            }
        }

        private static string GetStatusLabel(ComfyStatus status)
        {
            switch (status)
            {
                case ComfyStatus.Running: return T("运行中 (" + ComfyPort + ")", "Running (" + ComfyPort + ")");
                case ComfyStatus.Starting: return T("启动中...", "Starting...");
                default: return T("已停止", "Stopped");
            }
        }

        private static ComfyStatus GetComfyStatus()
        {
            if (IsHttpResponding(SystemStatsUrl))
                return ComfyStatus.Running;
            if (GetPortOwners(ComfyPort).Count > 0 || GetComfyPids().Count > 0)
                return ComfyStatus.Starting;
            return ComfyStatus.Stopped;
        }

        private static void SetTrayIcon(ComfyStatus status)
        {
            Icon oldIcon = currentIcon;
            currentIcon = CreateStatusIcon(status);
            trayIcon.Icon = currentIcon;
            if (oldIcon != null)
            {
                oldIcon.Dispose();
            }
        }

        private static Icon CreateStatusIcon(ComfyStatus status)
        {
            Color bg = Color.FromArgb(20, 24, 36);
            Color accent = status == ComfyStatus.Running
                ? Color.FromArgb(52, 211, 153)
                : status == ComfyStatus.Starting
                    ? Color.FromArgb(251, 191, 36)
                    : Color.FromArgb(148, 163, 184);

            using (Bitmap bmp = new Bitmap(16, 16))
            using (Graphics g = Graphics.FromImage(bmp))
            {
                g.Clear(Color.Transparent);
                using (Brush bgBrush = new SolidBrush(bg))
                using (Brush accBrush = new SolidBrush(accent))
                {
                    g.FillRectangle(bgBrush, 1, 1, 14, 14);
                    // Stylized 'C' + status dot
                    g.FillRectangle(accBrush, 3, 3, 10, 2);
                    g.FillRectangle(accBrush, 3, 3, 2, 10);
                    g.FillRectangle(accBrush, 3, 11, 10, 2);
                    g.FillRectangle(accBrush, 10, 7, 3, 2);
                }
                IntPtr hIcon = bmp.GetHicon();
                try
                {
                    return (Icon)Icon.FromHandle(hIcon).Clone();
                }
                finally
                {
                    DestroyIcon(hIcon);
                }
            }
        }

        private static void StartAll(bool openBrowsers)
        {
            StartVault(openBrowsers);
            StartComfy(openBrowsers);
        }

        private static void StartVault(bool openBrowser)
        {
            if (IsHttpResponding(VaultHealthUrl) || GetPortOwners(8189).Count > 0)
            {
                if (openBrowser) OpenUrl(VaultUrl);
                return;
            }
            if (!File.Exists(PythonExe) || !Directory.Exists(VaultDir))
            {
                return;
            }
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = PythonExe;
                psi.Arguments = "-s run_vault.py";
                psi.WorkingDirectory = VaultDir;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                Process.Start(psi);
                if (openBrowser) pendingOpenVault = true;
            }
            catch (Exception ex)
            {
                ShowTip(T("启动 ComfyVault 失败: ", "Failed to start ComfyVault: ") + ex.Message, ToolTipIcon.Error);
            }
        }

        private static void StartComfy(bool openBrowser)
        {
            ComfyStatus cur = GetComfyStatus();
            if (cur == ComfyStatus.Running)
            {
                if (openBrowser) OpenUrl(WebUrl);
                return;
            }
            if (cur == ComfyStatus.Starting)
            {
                if (openBrowser) pendingOpenComfy = true;
                return;
            }
            if (!File.Exists(BatPath))
            {
                ShowTip(T("找不到启动脚本: ", "Launch script not found: ") + BatPath, ToolTipIcon.Error);
                return;
            }
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = BatPath;
                psi.WorkingDirectory = BaseDir;
                psi.UseShellExecute = true;
                psi.WindowStyle = ProcessWindowStyle.Minimized;
                Process.Start(psi);
                if (openBrowser) pendingOpenComfy = true;
                ShowTip(T("正在启动 ComfyUI，就绪后自动打开网页...", "Starting ComfyUI, browser will open once ready..."), ToolTipIcon.Info);
            }
            catch (Exception ex)
            {
                ShowTip(T("启动 ComfyUI 失败: ", "Failed to start ComfyUI: ") + ex.Message, ToolTipIcon.Error);
            }
        }

        private static void RestartComfy()
        {
            StopComfy(false);
            Thread.Sleep(1200);
            StartComfy(false);
            ShowTip(T("正在重启 ComfyUI...", "Restarting ComfyUI..."), ToolTipIcon.Info);
        }

        private static void RestartVault()
        {
            StopVault(false);
            Thread.Sleep(800);
            StartVault(false);
            ShowTip(T("正在重启 ComfyVault...", "Restarting ComfyVault..."), ToolTipIcon.Info);
        }

        private static void RestartAll()
        {
            StopComfy(false);
            StopVault(false);
            Thread.Sleep(1200);
            StartAll(false);
            ShowTip(T("正在重启 ComfyUI 与 ComfyVault...", "Restarting ComfyUI & ComfyVault..."), ToolTipIcon.Info);
        }

        private static void StopAll(bool showTip)
        {
            StopComfy(false);
            StopVault(false);
            if (showTip) ShowTip(T("已停止 ComfyUI 与 ComfyVault 服务", "Stopped ComfyUI & ComfyVault"), ToolTipIcon.Info);
            RefreshStatus();
        }

        private static void StopVault(bool showTip)
        {
            StopPort(8189);
            if (showTip) ShowTip(T("已停止 ComfyVault", "Stopped ComfyVault"), ToolTipIcon.Info);
        }

        private static void StopComfy(bool showTip)
        {
            HashSet<int> pids = new HashSet<int>(GetPortOwners(ComfyPort));
            foreach (int pid in GetComfyPids()) pids.Add(pid);
            foreach (int pid in pids) KillPid(pid);
            if (showTip) ShowTip(T("已停止 ComfyUI", "Stopped ComfyUI"), ToolTipIcon.Info);
        }

        private static void StopPort(int port)
        {
            foreach (int pid in GetPortOwners(port)) KillPid(pid);
        }

        private static void KillPid(int pid)
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("taskkill", "/F /T /PID " + pid);
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process p = Process.Start(psi);
                if (p != null) p.WaitForExit(3000);
            }
            catch { }
        }

        private static List<int> GetComfyPids()
        {
            List<int> pids = new List<int>();
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo(
                    "powershell.exe",
                    "-NoProfile -Command \"Get-CimInstance Win32_Process -Filter \\\"Name LIKE 'python%'\\\" | Where-Object { $_.CommandLine -like '*ComfyUI*main.py*' } | Select-Object -ExpandProperty ProcessId\""
                );
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                    foreach (string line in output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        int pid;
                        if (int.TryParse(line.Trim(), out pid)) pids.Add(pid);
                    }
                }
            }
            catch { }
            return pids;
        }

        private static List<int> GetPortOwners(int port)
        {
            List<int> pids = new List<int>();
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo("netstat.exe", "-ano");
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string output = p.StandardOutput.ReadToEnd();
                    p.WaitForExit(3000);
                    Regex rx = new Regex(@":" + port + @"\s+.*LISTENING\s+(\d+)", RegexOptions.IgnoreCase);
                    foreach (Match m in rx.Matches(output))
                    {
                        int pid;
                        if (int.TryParse(m.Groups[1].Value, out pid) && !pids.Contains(pid))
                            pids.Add(pid);
                    }
                }
            }
            catch { }
            return pids;
        }

        private static bool IsHttpResponding(string url)
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(url);
                req.Timeout = 1000;
                req.ReadWriteTimeout = 1000;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    return (int)resp.StatusCode >= 200 && (int)resp.StatusCode < 400;
                }
            }
            catch
            {
                return false;
            }
        }

        private static void OpenUrl(string url)
        {
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            }
            catch { }
        }

        private static void ExitApp()
        {
            statusTimer.Stop();
            trayIcon.Visible = false;
            trayIcon.Dispose();
            Application.Exit();
        }

        private static void ShowTip(string text, ToolTipIcon icon)
        {
            try
            {
                trayIcon.ShowBalloonTip(3000, T("ComfyUI 启动器", "ComfyUI Launcher"), text, icon);
            }
            catch { }
        }
    }
}
