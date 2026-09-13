using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace QuickbitsHelper;

internal static class RecycleBin
{
    private const uint FO_DELETE = 3;
    private const ushort FOF_SILENT = 0x0004;
    private const ushort FOF_NOCONFIRMATION = 0x0010;
    private const ushort FOF_ALLOWUNDO = 0x0040;
    private const ushort FOF_NOERRORUI = 0x0400;

    private static readonly HashSet<string> VideoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".mkv",
        ".mp4",
        ".mov",
        ".m4v",
        ".flv",
        ".webm",
        ".mpeg",
        ".mpg",
        ".ts",
        ".m2ts",
        ".mts",
        ".avi"
    };

    public static int RecycleVideoFile(string? filePath, string? folderPath, int maxAgeSeconds)
    {
        if (string.IsNullOrWhiteSpace(filePath) || string.IsNullOrWhiteSpace(folderPath))
        {
            return Fail("missing-args");
        }

        maxAgeSeconds = Math.Clamp(maxAgeSeconds, 3, 120);

        string fileFull;
        string folderFull;
        try
        {
            fileFull = Path.GetFullPath(filePath);
            folderFull = Path.GetFullPath(folderPath);
        }
        catch
        {
            return Fail("unsafe-path");
        }

        if (fileFull.IndexOfAny(Path.GetInvalidPathChars()) >= 0 ||
            filePath.Contains('*', StringComparison.Ordinal) ||
            filePath.Contains('?', StringComparison.Ordinal))
        {
            return Fail("unsafe-path");
        }

        if (!IsFileInsideDirectory(fileFull, folderFull))
        {
            return Fail("unsafe-path");
        }

        if (!Directory.Exists(folderFull))
        {
            return Fail("folder-missing");
        }

        FileInfo info;
        try
        {
            info = new FileInfo(fileFull);
        }
        catch
        {
            return Fail("unsafe-path");
        }

        if (!info.Exists || (info.Attributes & FileAttributes.Directory) != 0)
        {
            return Fail("no-video");
        }

        if ((info.Attributes & FileAttributes.ReparsePoint) != 0)
        {
            return Fail("unsafe-path");
        }

        var ext = info.Extension;
        if (string.IsNullOrEmpty(ext) || !VideoExtensions.Contains(ext) || info.Name.StartsWith('.'))
        {
            return Fail("no-video");
        }

        var age = DateTime.UtcNow - info.LastWriteTimeUtc;
        if (age > TimeSpan.FromSeconds(maxAgeSeconds))
        {
            return Fail("too-old");
        }

        if (!TrySendToRecycleBin(fileFull))
        {
            return Fail("recycle-failed");
        }

        if (File.Exists(fileFull))
        {
            return Fail("recycle-failed");
        }

        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, fileName = info.Name }));
        return 0;
    }

    public static int RestoreVideoFile(string? filePath, string? folderPath)
    {
        if (string.IsNullOrWhiteSpace(filePath) || string.IsNullOrWhiteSpace(folderPath))
        {
            return Fail("missing-args");
        }

        string fileFull;
        string folderFull;
        try
        {
            fileFull = Path.GetFullPath(filePath);
            folderFull = Path.GetFullPath(folderPath);
        }
        catch
        {
            return Fail("unsafe-path");
        }

        if (fileFull.IndexOfAny(Path.GetInvalidPathChars()) >= 0 ||
            filePath.Contains('*', StringComparison.Ordinal) ||
            filePath.Contains('?', StringComparison.Ordinal))
        {
            return Fail("unsafe-path");
        }

        if (!IsFileInsideDirectory(fileFull, folderFull))
        {
            return Fail("unsafe-path");
        }

        if (!Directory.Exists(folderFull))
        {
            return Fail("folder-missing");
        }

        var name = Path.GetFileName(fileFull);
        var ext = Path.GetExtension(fileFull);
        if (string.IsNullOrEmpty(ext) || !VideoExtensions.Contains(ext) || name.StartsWith('.'))
        {
            return Fail("no-video");
        }

        if (File.Exists(fileFull))
        {
            return Fail("already-exists");
        }

        if (!TryRestoreFromRecycleBinFiles(fileFull))
        {
            return Fail("restore-failed");
        }

        if (!File.Exists(fileFull) || !IsFileInsideDirectory(Path.GetFullPath(fileFull), folderFull))
        {
            return Fail("restore-failed");
        }

        Console.WriteLine(JsonSerializer.Serialize(new { ok = true, fileName = name }));
        return 0;
    }

    private static bool TryRestoreFromRecycleBinFiles(string originalFullPath)
    {
        var root = Path.GetPathRoot(originalFullPath);
        if (string.IsNullOrEmpty(root))
        {
            return false;
        }

        var recycleRoot = Path.Combine(root, "$Recycle.Bin");
        if (!Directory.Exists(recycleRoot))
        {
            Console.Error.WriteLine($"[recycle] restore: no {recycleRoot}");
            return false;
        }

        foreach (var sidDir in EnumerateAccessibleDirectories(recycleRoot))
        {
            foreach (var iFile in EnumerateAccessibleFiles(sidDir, "$I*"))
            {
                var original = ReadOriginalPathFromIFile(iFile);
                if (original == null)
                {
                    continue;
                }

                string originalFull;
                try
                {
                    originalFull = Path.GetFullPath(original);
                }
                catch
                {
                    continue;
                }

                if (!string.Equals(originalFull, originalFullPath, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var iName = Path.GetFileName(iFile);
                if (iName.Length < 3 || !iName.StartsWith("$I", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var rPath = Path.Combine(Path.GetDirectoryName(iFile)!, "$R" + iName[2..]);
                if (!File.Exists(rPath))
                {
                    Console.Error.WriteLine($"[recycle] restore: matched $I but missing {rPath}");
                    return false;
                }

                try
                {
                    File.Move(rPath, originalFullPath);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[recycle] restore move failed: {ex.Message}");
                    return false;
                }

                try
                {
                    File.Delete(iFile);
                }
                catch
                {
                    // Recycle metadata leftover is acceptable after the file is back
                }

                return true;
            }
        }

        Console.Error.WriteLine($"[recycle] restore: no $I match for {originalFullPath}");
        return false;
    }

    private static IEnumerable<string> EnumerateAccessibleDirectories(string path)
    {
        try
        {
            return Directory.EnumerateDirectories(path);
        }
        catch
        {
            return [];
        }
    }

    private static IEnumerable<string> EnumerateAccessibleFiles(string path, string pattern)
    {
        try
        {
            return Directory.EnumerateFiles(path, pattern);
        }
        catch
        {
            return [];
        }
    }

    private static string? ReadOriginalPathFromIFile(string iPath)
    {
        byte[] data;
        try
        {
            data = File.ReadAllBytes(iPath);
        }
        catch
        {
            return null;
        }

        if (data.Length < 28)
        {
            return null;
        }

        var version = BitConverter.ToInt64(data, 0);
        try
        {
            if (version == 2)
            {
                var charCount = BitConverter.ToInt32(data, 24);
                var byteCount = charCount * 2;
                if (charCount <= 0 || 28 + byteCount > data.Length)
                {
                    return null;
                }

                return Encoding.Unicode.GetString(data, 28, byteCount).TrimEnd('\0');
            }

            return Encoding.Unicode.GetString(data, 24, data.Length - 24).TrimEnd('\0');
        }
        catch
        {
            return null;
        }
    }

    private static int Fail(string error)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { ok = false, error }));
        return 1;
    }

    private static bool IsFileInsideDirectory(string fileFull, string folderFull)
    {
        var prefix = folderFull.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
            + Path.DirectorySeparatorChar;
        return fileFull.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            && !string.Equals(fileFull, folderFull, StringComparison.OrdinalIgnoreCase);
    }

    private static bool TrySendToRecycleBin(string fileFull)
    {
        var op = new SHFILEOPSTRUCT
        {
            hwnd = IntPtr.Zero,
            wFunc = FO_DELETE,
            pFrom = fileFull + "\0\0",
            pTo = null!,
            fFlags = (ushort)(FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI),
            fAnyOperationsAborted = 0,
            hNameMappings = IntPtr.Zero,
            lpszProgressTitle = null!
        };

        var result = SHFileOperation(ref op);
        return result == 0 && op.fAnyOperationsAborted == 0;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern int SHFileOperation(ref SHFILEOPSTRUCT lpFileOp);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEOPSTRUCT
    {
        public IntPtr hwnd;
        public uint wFunc;
        public string pFrom;
        public string pTo;
        public ushort fFlags;
        public int fAnyOperationsAborted;
        public IntPtr hNameMappings;
        public string lpszProgressTitle;
    }
}
