using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

internal static class DesktopAppLauncher
{
    [STAThread]
    private static void Main()
    {
        string executable = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Nerdzone Bot Manager", "Nerdzone Bot Manager.exe");
        if (!File.Exists(executable))
        {
            MessageBox.Show("A instalação local do aplicativo não foi encontrada.", "Nerdzone Bot Manager", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return;
        }
        Process.Start(new ProcessStartInfo { FileName = executable, WorkingDirectory = Path.GetDirectoryName(executable), UseShellExecute = true });
    }
}
