using System;
using System.Diagnostics;
using System.IO;

internal static class NerdzoneLauncher
{
    [STAThread]
    private static void Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "scripts", "nerdzone-launcher.ps1");
        if (!File.Exists(script))
        {
            System.Windows.Forms.MessageBox.Show(
                "O arquivo scripts\\nerdzone-launcher.ps1 nao foi encontrado.",
                "Nerdzone Bot Manager",
                System.Windows.Forms.MessageBoxButtons.OK,
                System.Windows.Forms.MessageBoxIcon.Error);
            return;
        }

        var info = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"",
            WorkingDirectory = root,
            UseShellExecute = true
        };
        Process process = Process.Start(info);
        if (process != null) process.WaitForExit();
    }
}
