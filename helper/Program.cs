using System.Runtime.InteropServices;
using System.Text.Json;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace QuickbitsHelper;

internal static class Program
{
    static async Task<int> Main(string[] args)
    {
        if (args.Length == 0)
        {
            Console.Error.WriteLine("Usage: QuickbitsHelper.exe <command> [options]");
            Console.Error.WriteLine("Commands:");
            Console.Error.WriteLine("  set-volume --percent <0-100>");
            Console.Error.WriteLine("  toggle-dnd");
            Console.Error.WriteLine("  media-play-pause");
            Console.Error.WriteLine("  media-next");
            Console.Error.WriteLine("  media-previous");
            Console.Error.WriteLine("  media-info [--source <name>]");
            Console.Error.WriteLine("  media-like");
            Console.Error.WriteLine("  spotify-daemon [--filter <name>] [--plugin-dir <path>]");
            return 1;
        }

        var command = args[0].ToLowerInvariant();

        try
        {
            return command switch
            {
                "set-volume" => HandleSetVolume(args),
                "toggle-dnd" => HandleToggleDnd(),
                "media-play-pause" => HandleMediaPlayPause(),
                "media-next" => HandleMediaNext(),
                "media-previous" => HandleMediaPrevious(),
                "media-info" => await HandleMediaInfo(args),
                "media-like" => HandleMediaLike(),
                "spotify-daemon" => await HandleSpotifyDaemon(args),
                _ => UnknownCommand(command)
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"Error: {ex.Message}");
            return 1;
        }
    }

    static int HandleSetVolume(string[] args)
    {
        int percent = 30;

        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--percent" && i + 1 < args.Length)
            {
                if (int.TryParse(args[i + 1], out var p))
                {
                    percent = p;
                }
                i++;
            }
        }

        percent = Math.Clamp(percent, 0, 100);
        float scalar = percent / 100f;

        AudioManager.SetMasterVolume(scalar);
        AudioManager.SetMute(false);
        MediaKeys.ShowVolumeFlyout();
        Thread.Sleep(50);
        AudioManager.SetMasterVolume(scalar);
        AudioManager.SetMute(false);

        Console.WriteLine($"Volume set to {percent}%");
        return 0;
    }

    static int HandleToggleDnd()
    {
        Keyboard.KeyCombo(VK.LWIN, VK.N);
        Thread.Sleep(800);

        Keyboard.Key(VK.RETURN);
        Thread.Sleep(100);

        Keyboard.Key(VK.ESCAPE);

        Console.WriteLine("DND toggled");
        return 0;
    }

    static int HandleMediaPlayPause()
    {
        Keyboard.Key(VK.MEDIA_PLAY_PAUSE);
        Console.WriteLine("Play/Pause sent");
        return 0;
    }

    static int HandleMediaNext()
    {
        Keyboard.Key(VK.MEDIA_NEXT_TRACK);
        Console.WriteLine("Next track sent");
        return 0;
    }

    static int HandleMediaPrevious()
    {
        Keyboard.Key(VK.MEDIA_PREV_TRACK);
        Console.WriteLine("Previous track sent");
        return 0;
    }

    static int HandleMediaLike()
    {
        Keyboard.KeyCombo3(VK.CONTROL, VK.SHIFT, VK.S);
        Console.WriteLine("Like hotkey sent");
        return 0;
    }

    static async Task<int> HandleMediaInfo(string[] args)
    {
        string? sourceFilter = null;
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--source" && i + 1 < args.Length)
            {
                sourceFilter = args[i + 1].ToLowerInvariant();
                i++;
            }
        }

        var info = await MediaSession.GetCurrentMediaInfo(sourceFilter);
        Console.WriteLine(JsonSerializer.Serialize(info));
        return 0;
    }

    static async Task<int> HandleSpotifyDaemon(string[] args)
    {
        var filter = "Spotify";
        var pluginDir = Directory.GetCurrentDirectory();
        for (int i = 1; i < args.Length; i++)
        {
            if (args[i] == "--filter" && i + 1 < args.Length)
            {
                filter = args[i + 1];
                i++;
            }
            else if (args[i] == "--plugin-dir" && i + 1 < args.Length)
            {
                pluginDir = args[i + 1];
                i++;
            }
        }

        var daemon = new SpotifyDaemon(filter, pluginDir);
        await daemon.RunAsync();
        return 0;
    }

    static int UnknownCommand(string command)
    {
        Console.Error.WriteLine($"Unknown command: {command}");
        return 1;
    }
}

internal static class AudioManager
{
    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    internal enum EDataFlow { eRender, eCapture, eAll }
    internal enum ERole { eConsole, eMultimedia, eCommunications }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        int NotImpl1();
        [PreserveSig]
        int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice ppDevice);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
            [MarshalAs(UnmanagedType.Interface)] out object ppInterface);
    }

    [ComImport]
    [Guid("5CDF2C82-841E-4546-9722-0CF74078229A")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr pNotify);
        int UnregisterControlChangeNotify(IntPtr pNotify);
        int GetChannelCount(out uint pnChannelCount);
        int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        [PreserveSig]
        int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        int GetMasterVolumeLevel(out float pfLevelDB);
        [PreserveSig]
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        [PreserveSig]
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        [PreserveSig]
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
        int GetVolumeStepInfo(out uint pnStep, out uint pnStepCount);
        int VolumeStepUp(ref Guid pguidEventContext);
        int VolumeStepDown(ref Guid pguidEventContext);
        int QueryHardwareSupport(out uint pdwHardwareSupportMask);
        int GetVolumeRange(out float pflVolumeMindB, out float pflVolumeMaxdB, out float pflVolumeIncrementdB);
    }

    private const int CLSCTX_ALL = 23;

    private static IAudioEndpointVolume GetEndpointVolume()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eMultimedia, out var device));

        var iid = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(device.Activate(ref iid, CLSCTX_ALL, IntPtr.Zero, out var endpointVolume));

        return (IAudioEndpointVolume)endpointVolume;
    }

    public static void SetMasterVolume(float level)
    {
        level = Math.Clamp(level, 0f, 1f);
        var context = Guid.Empty;
        Marshal.ThrowExceptionForHR(GetEndpointVolume().SetMasterVolumeLevelScalar(level, ref context));
    }

    public static void SetMute(bool mute)
    {
        var context = Guid.Empty;
        Marshal.ThrowExceptionForHR(GetEndpointVolume().SetMute(mute, ref context));
    }
}

internal static class MediaKeys
{
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private const byte VK_VOLUME_DOWN = 0xAE;
    private const byte VK_VOLUME_UP = 0xAF;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    public static void ShowVolumeFlyout()
    {
        keybd_event(VK_VOLUME_DOWN, 0, 0, UIntPtr.Zero);
        keybd_event(VK_VOLUME_DOWN, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        Thread.Sleep(35);
        keybd_event(VK_VOLUME_UP, 0, 0, UIntPtr.Zero);
        keybd_event(VK_VOLUME_UP, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}

internal static class VK
{
    public const byte RETURN = 0x0D;
    public const byte ESCAPE = 0x1B;
    public const byte LWIN = 0x5B;
    public const byte N = 0x4E;
    public const byte S = 0x53;
    public const byte CONTROL = 0x11;
    public const byte SHIFT = 0x10;
    public const byte MEDIA_NEXT_TRACK = 0xB0;
    public const byte MEDIA_PREV_TRACK = 0xB1;
    public const byte MEDIA_PLAY_PAUSE = 0xB3;
}

internal static class Keyboard
{
    [DllImport("user32.dll")]
    private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

    private const uint KEYEVENTF_KEYUP = 0x0002;

    public static void Key(byte vk)
    {
        keybd_event(vk, 0, 0, UIntPtr.Zero);
        keybd_event(vk, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void KeyCombo(byte key1, byte key2)
    {
        keybd_event(key1, 0, 0, UIntPtr.Zero);
        keybd_event(key2, 0, 0, UIntPtr.Zero);
        keybd_event(key2, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(key1, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    public static void KeyCombo3(byte key1, byte key2, byte key3)
    {
        keybd_event(key1, 0, 0, UIntPtr.Zero);
        keybd_event(key2, 0, 0, UIntPtr.Zero);
        keybd_event(key3, 0, 0, UIntPtr.Zero);
        keybd_event(key3, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(key2, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        keybd_event(key1, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }
}

internal static class MediaSession
{
    public record MediaInfo(
        string? Title,
        string? Artist,
        string? Album,
        string? Source,
        string? PlaybackStatus,
        string? Thumbnail
    );

    public static async Task<MediaInfo> GetCurrentMediaInfo(string? sourceFilter = null)
    {
        var sessionManager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        var sessions = sessionManager.GetSessions();

        GlobalSystemMediaTransportControlsSession? targetSession = null;

        if (!string.IsNullOrEmpty(sourceFilter))
        {
            targetSession = sessions.FirstOrDefault(s =>
                s.SourceAppUserModelId.ToLowerInvariant().Contains(sourceFilter));
        }

        targetSession ??= sessionManager.GetCurrentSession();

        if (targetSession == null)
        {
            return new MediaInfo(null, null, null, null, null, null);
        }

        var mediaProps = await targetSession.TryGetMediaPropertiesAsync();
        var playbackInfo = targetSession.GetPlaybackInfo();

        string? thumbnailBase64 = null;
        if (mediaProps?.Thumbnail != null)
        {
            try
            {
                var stream = await mediaProps.Thumbnail.OpenReadAsync();
                using var reader = new DataReader(stream);
                await reader.LoadAsync((uint)stream.Size);
                var bytes = new byte[stream.Size];
                reader.ReadBytes(bytes);
                thumbnailBase64 = Convert.ToBase64String(bytes);
            }
            catch { }
        }

        var status = playbackInfo?.PlaybackStatus switch
        {
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => "playing",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused => "paused",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped => "stopped",
            _ => "unknown"
        };

        return new MediaInfo(
            mediaProps?.Title,
            mediaProps?.Artist,
            mediaProps?.AlbumTitle,
            targetSession.SourceAppUserModelId,
            status,
            thumbnailBase64
        );
    }
}

internal static class KeyboardHelper
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public int type;
        public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public static void SendKey(byte vk)
    {
        var inputs = new INPUT[2];

        inputs[0] = new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk } }
        };

        inputs[1] = new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION { ki = new KEYBDINPUT { wVk = vk, dwFlags = KEYEVENTF_KEYUP } }
        };

        SendInput(2, inputs, Marshal.SizeOf<INPUT>());
    }

    public static void SendKeyCombo(byte key1, byte key2)
    {
        var inputs = new INPUT[4];

        inputs[0] = new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION { ki = new KEYBDINPUT { wVk = key1 } }
        };
        inputs[1] = new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION { ki = new KEYBDINPUT { wVk = key2 } }
        };
        inputs[2] = new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION { ki = new KEYBDINPUT { wVk = key2, dwFlags = KEYEVENTF_KEYUP } }
        };
        inputs[3] = new INPUT
        {
            type = INPUT_KEYBOARD,
            u = new INPUTUNION { ki = new KEYBDINPUT { wVk = key1, dwFlags = KEYEVENTF_KEYUP } }
        };

        SendInput(4, inputs, Marshal.SizeOf<INPUT>());
    }
}
