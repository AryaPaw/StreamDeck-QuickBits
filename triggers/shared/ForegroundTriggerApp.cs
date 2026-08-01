using System.Runtime.InteropServices;

namespace Quickbits.Triggers;

public static class ForegroundTriggerApp
{
	/// <summary>
	/// Entry point. Focus stealing is OFF by default (for Skydimo "app is running" rules).
	/// Pass "--foreground" (or "-fg") as a CLI arg to force the old foreground behavior
	/// (for Skydimo "app is foreground" / "title contains" rules).
	/// </summary>
	public static void Run(string windowTitle)
	{
		var args = Environment.GetCommandLineArgs();
		var stealFocus = args.Any(a =>
			a.Equals("--foreground", StringComparison.OrdinalIgnoreCase) ||
			a.Equals("-fg", StringComparison.OrdinalIgnoreCase));
		Run(windowTitle, stealFocus);
	}

	public static void Run(string windowTitle, bool stealFocus, int foregroundHoldMs = 900, int aliveMs = 1000)
	{
		ApplicationConfiguration.Initialize();
		Application.Run(new TriggerForm(windowTitle, stealFocus, foregroundHoldMs, aliveMs));
	}
}

internal sealed class TriggerForm : Form
{
	private readonly bool _stealFocus;
	private readonly int _foregroundHoldMs;
	private readonly System.Windows.Forms.Timer _closeTimer = new();
	private readonly System.Windows.Forms.Timer _reassertTimer = new();
	private int _reassertElapsedMs;

	public TriggerForm(string windowTitle, bool stealFocus, int foregroundHoldMs, int aliveMs)
	{
		_stealFocus = stealFocus;
		_foregroundHoldMs = Math.Clamp(foregroundHoldMs, 0, 5000);

		Text = windowTitle;
		FormBorderStyle = FormBorderStyle.None;
		ShowInTaskbar = false;
		StartPosition = FormStartPosition.Manual;
		Location = new Point(-20000, -20000);
		Size = new Size(1, 1);
		Opacity = 0.01;
		TopMost = _stealFocus;
		BackColor = Color.Black;

		// Re-assert foreground periodically so Skydimo has time to catch the window (foreground rules only)
		_reassertTimer.Interval = 150;
		_reassertTimer.Tick += (_, _) =>
		{
			_reassertElapsedMs += _reassertTimer.Interval;
			NativeMethods.TrySetForegroundWindow(Handle);
			if (_reassertElapsedMs >= _foregroundHoldMs)
			{
				_reassertTimer.Stop();
			}
		};

		// Keep the process alive long enough for "app is running" / process-exists detection
		_closeTimer.Interval = Math.Max(50, aliveMs);
		_closeTimer.Tick += (_, _) =>
		{
			_closeTimer.Stop();
			Close();
		};
	}

	// When not stealing focus, show the window without activating it (does not switch the active window)
	protected override bool ShowWithoutActivation => !_stealFocus;

	protected override CreateParams CreateParams
	{
		get
		{
			const int WS_EX_TOOLWINDOW = 0x00000080;
			const int WS_EX_NOACTIVATE = 0x08000000;
			var cp = base.CreateParams;
			cp.ExStyle |= WS_EX_TOOLWINDOW;
			if (!_stealFocus)
			{
				cp.ExStyle |= WS_EX_NOACTIVATE;
			}
			return cp;
		}
	}

	protected override void OnShown(EventArgs e)
	{
		base.OnShown(e);
		if (_stealFocus)
		{
			NativeMethods.TrySetForegroundWindow(Handle);
			_reassertTimer.Start();
		}
		_closeTimer.Start();
	}

	protected override void OnLoad(EventArgs e)
	{
		base.OnLoad(e);
		if (_stealFocus)
		{
			NativeMethods.TrySetForegroundWindow(Handle);
		}
	}

	protected override void OnFormClosed(FormClosedEventArgs e)
	{
		_reassertTimer.Dispose();
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
