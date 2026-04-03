using System.Runtime.InteropServices;

namespace Quickbits.Triggers;

public static class ForegroundTriggerApp
{
	public static void Run(string windowTitle, int foregroundHoldMs = 280, int closeAfterMs = 450)
	{
		ApplicationConfiguration.Initialize();
		Application.Run(new TriggerForm(windowTitle, foregroundHoldMs, closeAfterMs));
	}
}

internal sealed class TriggerForm : Form
{
	private readonly int _foregroundHoldMs;
	private readonly System.Windows.Forms.Timer _closeTimer = new();

	public TriggerForm(string windowTitle, int foregroundHoldMs, int closeAfterMs)
	{
		_foregroundHoldMs = foregroundHoldMs;

		Text = windowTitle;
		FormBorderStyle = FormBorderStyle.None;
		ShowInTaskbar = false;
		StartPosition = FormStartPosition.Manual;
		Location = new Point(-20000, -20000);
		Size = new Size(1, 1);
		Opacity = 0.01;
		TopMost = true;
		BackColor = Color.Black;

		_closeTimer.Interval = Math.Max(50, closeAfterMs);
		_closeTimer.Tick += (_, _) =>
		{
			_closeTimer.Stop();
			Close();
		};
	}

	protected override CreateParams CreateParams
	{
		get
		{
			const int WS_EX_TOOLWINDOW = 0x00000080;
			var cp = base.CreateParams;
			cp.ExStyle |= WS_EX_TOOLWINDOW;
			return cp;
		}
	}

	protected override void OnShown(EventArgs e)
	{
		base.OnShown(e);
		NativeMethods.TrySetForegroundWindow(Handle);
		_closeTimer.Start();
	}

	protected override void OnLoad(EventArgs e)
	{
		base.OnLoad(e);
		NativeMethods.TrySetForegroundWindow(Handle);
		BeginInvoke(() =>
		{
			NativeMethods.TrySetForegroundWindow(Handle);
			Thread.Sleep(Math.Clamp(_foregroundHoldMs, 0, 2000));
			NativeMethods.TrySetForegroundWindow(Handle);
		});
	}

	protected override void OnFormClosed(FormClosedEventArgs e)
	{
		_closeTimer.Dispose();
		base.OnFormClosed(e);
	}
}

internal static class NativeMethods
{
	[DllImport("user32.dll")]
	private static extern bool SetForegroundWindow(IntPtr hWnd);

	[DllImport("user32.dll")]
	private static extern IntPtr GetForegroundWindow();

	[DllImport("user32.dll")]
	private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

	[DllImport("kernel32.dll")]
	private static extern uint GetCurrentThreadId();

	[DllImport("user32.dll")]
	private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

	[DllImport("user32.dll")]
	private static extern bool BringWindowToTop(IntPtr hWnd);

	internal static void TrySetForegroundWindow(IntPtr hWnd)
	{
		try
		{
			var fg = GetForegroundWindow();
			var fgThread = fg == IntPtr.Zero ? 0u : GetWindowThreadProcessId(fg, out _);
			var cur = GetCurrentThreadId();
			if (fgThread != 0 && cur != fgThread)
			{
				AttachThreadInput(cur, fgThread, true);
			}

			BringWindowToTop(hWnd);
			SetForegroundWindow(hWnd);

			if (fgThread != 0 && cur != fgThread)
			{
				AttachThreadInput(cur, fgThread, false);
			}
		}
		catch
		{
			SetForegroundWindow(hWnd);
		}
	}
}
