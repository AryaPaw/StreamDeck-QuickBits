using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Windows.Foundation;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace QuickbitsHelper;

internal sealed class SpotifyDaemon
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private readonly string _filter;
    private readonly string _pluginDir;
    private static readonly int[] ArtworkRetryDelaysMs = [40, 80, 120, 200, 350, 500];
    private readonly object _gate = new();
    private readonly object _writeLock = new();
    private readonly SemaphoreSlim _stateEmitLock = new(1, 1);
    private GlobalSystemMediaTransportControlsSessionManager? _manager;
    private GlobalSystemMediaTransportControlsSession? _session;
    private CancellationTokenSource _cts = new();
    private Timer? _debounceTimer;
    private Timer? _pollTimer;
    private readonly Timer?[] _artworkRetryTimers = new Timer?[ArtworkRetryDelaysMs.Length];
    private bool _running = true;
    private const int PlayingPollIntervalMs = 1000;
    private const int PausedPollIntervalMs = 750;
    private int _pollIntervalMs = PausedPollIntervalMs;
    private int _errorBackoffMs;
    private SpotifyLocalStatePayload? _lastState;
    private SpotifyLocalStatePayload? _lastGoodState;
    private string? _lastArtworkKey;
    private GlobalSystemMediaTransportControlsSession? _boundSession;
    private long _lastTransportUtcMs;
    private const int TransportGraceMs = 500;
    private const int MaxArtworkCacheFiles = 50;
    private const int MaxArtworkAgeDays = 7;
    private const int ArtworkPruneDebounceMs = 300_000;
    private const int ArtworkTmpMaxAgeHours = 1;
    private const int ArtworkHashBytes = 12;
    private readonly SemaphoreSlim _artworkEmitLock = new(1, 1);
    private readonly StreamReader _stdinReader = new(Console.OpenStandardInput());
    private Timer? _artworkPruneTimer;
    private long _lastArtworkPruneUtcMs;

    public SpotifyDaemon(string filter, string pluginDir)
    {
        _filter = filter;
        _pluginDir = pluginDir;
    }

    public async Task RunAsync()
    {
        try
        {
            _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            BindManagerEvents(_manager);
            _session = FindSpotifySession(_manager);
            if (_session != null)
            {
                BindSessionEvents(_session);
            }

            WriteEvent(new { @event = "ready", filter = _filter, sessions = _manager.GetSessions().Count });
            PruneArtworkCache();
            _lastArtworkPruneUtcMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            _ = Task.Run(ReadCommandsLoopAsync);
            SchedulePoll(0);
            _ = RefreshSessionSnapshotAsync(force: true);

            while (_running && !_cts.Token.IsCancellationRequested)
            {
                await Task.Delay(200, _cts.Token);
            }
        }
        catch (OperationCanceledException)
        {
            // shutdown
        }
        catch (Exception ex)
        {
            WriteEvent(new { @event = "error", message = ex.Message });
        }
        finally
        {
            Cleanup();
        }
    }

    private async Task ReadCommandsLoopAsync()
    {
        try
        {
            while (_running)
            {
                var line = await _stdinReader.ReadLineAsync();
                if (line == null)
                {
                    _running = false;
                    _cts.Cancel();
                    break;
                }

                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                DaemonCommand? command;
                try
                {
                    command = JsonSerializer.Deserialize<DaemonCommand>(line, JsonOptions);
                }
                catch
                {
                    WriteEvent(new { @event = "error", message = "Invalid JSON command" });
                    continue;
                }

                if (command == null || string.IsNullOrWhiteSpace(command.Cmd))
                {
                    continue;
                }

                await HandleCommandAsync(command);
            }
        }
        catch
        {
            _running = false;
            _cts.Cancel();
        }
    }

    private async Task HandleCommandAsync(DaemonCommand command)
    {
        var cmd = command.Cmd.ToLowerInvariant();
        bool ok = false;
        string? error = null;

        try
        {
            switch (cmd)
            {
                case "getstate":
                    ok = true;
                    break;
                case "shutdown":
                    _running = false;
                    _cts.Cancel();
                    ok = true;
                    break;
                case "play":
                    ok = await RunTransportAsync(s => s.TryPlayAsync(), () => Keyboard.Key(VK.MEDIA_PLAY_PAUSE));
                    break;
                case "pause":
                    ok = await RunTransportAsync(s => s.TryPauseAsync(), () => Keyboard.Key(VK.MEDIA_PLAY_PAUSE));
                    break;
                case "toggleplaypause":
                    ok = await RunTransportAsync(s => s.TryTogglePlayPauseAsync(), () => Keyboard.Key(VK.MEDIA_PLAY_PAUSE));
                    break;
                case "next":
                    ok = await RunTransportAsync(s => s.TrySkipNextAsync(), () => Keyboard.Key(VK.MEDIA_NEXT_TRACK));
                    break;
                case "previous":
                    ok = await RunTransportAsync(s => s.TrySkipPreviousAsync(), () => Keyboard.Key(VK.MEDIA_PREV_TRACK));
                    break;
                case "refreshartwork":
                    ok = true;
                    break;
                default:
                    error = $"Unknown command: {command.Cmd}";
                    break;
            }
        }
        catch (Exception ex)
        {
            error = ex.Message;
        }

        if (command.Id.HasValue)
        {
            WriteResult(new { id = command.Id.Value, @event = "result", ok, error });
        }

        switch (cmd)
        {
            case "getstate":
                _ = OnMediaPropertiesChangedAsync();
                break;
            case "play" or "pause" or "toggleplaypause" or "next" or "previous" when ok:
                MarkTransport();
                _ = OnMediaPropertiesChangedAsync();
                ScheduleStateEmitDebounced();
                break;
            case "refreshartwork":
                _ = EmitArtworkAsync(force: true);
                ScheduleArtworkRetry();
                break;
        }
    }

    private async Task<bool> RunTransportAsync(
        Func<GlobalSystemMediaTransportControlsSession, IAsyncOperation<bool>> gsmtcAction,
        Action fallbackKey)
    {
        var runTask = RunTransportInnerAsync(gsmtcAction, fallbackKey);
        if (await Task.WhenAny(runTask, Task.Delay(3000)) != runTask)
        {
            fallbackKey();
            return true;
        }

        return await runTask;
    }

    private async Task<bool> RunTransportInnerAsync(
        Func<GlobalSystemMediaTransportControlsSession, IAsyncOperation<bool>> gsmtcAction,
        Action fallbackKey)
    {
        try
        {
            var session = await GetOrRefreshSessionAsync();
            if (session != null)
            {
                var transportTask = Task.Run(async () =>
                {
                    try
                    {
                        return await gsmtcAction(session);
                    }
                    catch
                    {
                        return false;
                    }
                });

                if (await Task.WhenAny(transportTask, Task.Delay(1500)) == transportTask && await transportTask)
                {
                    return true;
                }
            }
        }
        catch
        {
            // fall through to media keys
        }

        fallbackKey();
        return true;
    }

    private void BindManagerEvents(GlobalSystemMediaTransportControlsSessionManager manager)
    {
        manager.CurrentSessionChanged += (_, _) => OnSessionChanged();
        manager.SessionsChanged += (_, _) => OnSessionChanged();
    }

    private void BindSessionEvents(GlobalSystemMediaTransportControlsSession session)
    {
        lock (_gate)
        {
            if (_boundSession == session)
            {
                return;
            }

            _boundSession = session;
        }

        session.MediaPropertiesChanged += (_, _) =>
        {
            _ = OnMediaPropertiesChangedAsync();
        };
        session.PlaybackInfoChanged += (_, _) => _ = EmitPlaybackStateAsync();
        session.TimelinePropertiesChanged += (_, _) => ScheduleStateEmitDebounced();
    }

    private void MarkTransport()
    {
        _lastTransportUtcMs = Environment.TickCount64;
    }

    private bool IsInTransportGrace()
    {
        return Environment.TickCount64 - _lastTransportUtcMs < TransportGraceMs;
    }

    private void OnSessionChanged()
    {
        lock (_gate)
        {
            _boundSession = null;
            _session = _manager != null ? FindSpotifySession(_manager) : null;
            if (_session != null)
            {
                BindSessionEvents(_session);
            }
        }

        _lastArtworkKey = null;
        _ = RefreshSessionSnapshotAsync(force: true);
    }

    private async Task RefreshSessionSnapshotAsync(bool force = false)
    {
        try
        {
            var session = await GetOrRefreshSessionAsync();
            if (session == null)
            {
                await EmitStateAsync(force);
                return;
            }

            var mediaProps = await session.TryGetMediaPropertiesAsync();
            await EmitArtworkFromMediaPropsAsync(mediaProps, force);
            await EmitStateFromSessionAsync(session, mediaProps, force);
            if (force)
            {
                ScheduleArtworkRetry();
            }
        }
        catch (Exception ex)
        {
            WriteEvent(new { @event = "error", message = ex.Message });
        }
    }

    private void ScheduleStateEmitDebounced()
    {
        lock (_gate)
        {
            _debounceTimer?.Dispose();
            _debounceTimer = new Timer(_ =>
            {
                _ = EmitStateAsync();
            }, null, 150, Timeout.Infinite);
        }
    }

    private void ScheduleArtworkRetry()
    {
        lock (_gate)
        {
            for (var i = 0; i < _artworkRetryTimers.Length; i++)
            {
                _artworkRetryTimers[i]?.Dispose();
                _artworkRetryTimers[i] = new Timer(_ =>
                {
                    _ = EmitArtworkAsync(force: true);
                }, null, ArtworkRetryDelaysMs[i], Timeout.Infinite);
            }
        }
    }

    private async Task OnMediaPropertiesChangedAsync()
    {
        try
        {
            var session = await GetOrRefreshSessionAsync();
            if (session == null)
            {
                return;
            }

            var mediaProps = await session.TryGetMediaPropertiesAsync();
            await EmitArtworkFromMediaPropsAsync(mediaProps, force: true);
            await EmitStateFromSessionAsync(session, mediaProps, force: true);
            ScheduleArtworkRetry();
        }
        catch (Exception ex)
        {
            WriteEvent(new { @event = "error", message = ex.Message });
        }
    }

    private void SchedulePoll(int delayMs)
    {
        lock (_gate)
        {
            _pollTimer?.Dispose();
            var delay = delayMs > 0 ? delayMs : _pollIntervalMs;
            if (_errorBackoffMs > 0)
            {
                delay = Math.Max(delay, _errorBackoffMs);
            }

            _pollTimer = new Timer(_ =>
            {
                _ = EmitStateAsync();
            }, null, delay, Timeout.Infinite);
        }
    }

    private async Task EmitPlaybackStateAsync()
    {
        try
        {
            var session = await GetOrRefreshSessionAsync();
            if (session == null)
            {
                return;
            }

            var mediaProps = await session.TryGetMediaPropertiesAsync();
            await EmitStateFromSessionAsync(session, mediaProps, force: true);
        }
        catch (Exception ex)
        {
            WriteEvent(new { @event = "error", message = ex.Message });
        }
    }

    private async Task EmitStateAsync(bool force = false)
    {
        await _stateEmitLock.WaitAsync(_cts.Token);

        try
        {
            var state = await BuildStateAsync();
            if (!CommitState(state, force))
            {
                return;
            }

            WriteEvent(new { @event = "state", payload = state });
            SchedulePoll(0);
        }
        catch (Exception ex)
        {
            _errorBackoffMs = Math.Min(_errorBackoffMs == 0 ? 2000 : _errorBackoffMs * 2, 10000);
            WriteEvent(new { @event = "error", message = ex.Message });
            SchedulePoll(_errorBackoffMs);
        }
        finally
        {
            _stateEmitLock.Release();
        }
    }

    private Task EmitArtworkAsync(bool force = false)
    {
        return EmitArtworkFromMediaPropsAsync(null, force);
    }

    private async Task EmitArtworkFromMediaPropsAsync(
        GlobalSystemMediaTransportControlsSessionMediaProperties? mediaProps,
        bool force)
    {
        try
        {
            if (mediaProps == null)
            {
                var session = await GetOrRefreshSessionAsync();
                if (session == null)
                {
                    return;
                }

                mediaProps = await session.TryGetMediaPropertiesAsync();
            }

            var title = mediaProps?.Title ?? "";
            var artist = mediaProps?.Artist ?? "";
            var album = mediaProps?.AlbumTitle ?? "";
            if (string.IsNullOrWhiteSpace(title) || mediaProps?.Thumbnail == null)
            {
                return;
            }

            var artworkKey = BuildArtworkKey(title, artist, album);
            if (!force && artworkKey == _lastArtworkKey)
            {
                return;
            }

            var artworkBytes = await ReadThumbnailBytesAsync(mediaProps.Thumbnail);
            if (artworkBytes == null || artworkBytes.Length == 0)
            {
                return;
            }

            await _artworkEmitLock.WaitAsync(_cts.Token);
            try
            {
                if (!force && artworkKey == _lastArtworkKey)
                {
                    return;
                }

                var relativePath = BuildArtworkCacheRelativePath(artworkKey);
                var cachePath = Path.Combine(_pluginDir, relativePath);
                var cacheDir = Path.GetDirectoryName(cachePath);
                if (!string.IsNullOrEmpty(cacheDir))
                {
                    Directory.CreateDirectory(cacheDir);
                }

                var tempPath = cachePath + ".tmp";
                await File.WriteAllBytesAsync(tempPath, artworkBytes);
                File.Move(tempPath, cachePath, overwrite: true);

                _lastArtworkKey = artworkKey;
                WriteEvent(new
                {
                    @event = "artwork",
                    title,
                    artist,
                    album,
                    artworkPath = relativePath
                });

                MaybeScheduleArtworkCachePrune();

                var session = await GetOrRefreshSessionAsync();
                if (session != null)
                {
                    var props = mediaProps ?? await session.TryGetMediaPropertiesAsync();
                    await EmitStateFromSessionAsync(session, props, force: true);
                }
            }
            finally
            {
                _artworkEmitLock.Release();
            }
        }
        catch
        {
            // artwork is optional
        }
    }

    private async Task EmitStateFromSessionAsync(
        GlobalSystemMediaTransportControlsSession session,
        GlobalSystemMediaTransportControlsSessionMediaProperties? mediaProps,
        bool force)
    {
        await _stateEmitLock.WaitAsync(_cts.Token);

        try
        {
            var state = BuildStateFromSession(session, mediaProps);
            if (!CommitState(state, force))
            {
                return;
            }

            WriteEvent(new { @event = "state", payload = state });
            SchedulePoll(0);
        }
        finally
        {
            _stateEmitLock.Release();
        }
    }

    private bool CommitState(SpotifyLocalStatePayload state, bool force)
    {
        lock (_gate)
        {
            _errorBackoffMs = 0;
            _pollIntervalMs = state.Player.State == "playing" ? PlayingPollIntervalMs : PausedPollIntervalMs;

            if (!force && StatesEqual(_lastState, state))
            {
                SchedulePoll(0);
                return false;
            }

            _lastState = state;
            if (state.IsRunning && state.CurrentTrack != null)
            {
                _lastGoodState = state;
            }
        }

        return true;
    }

    private static string BuildArtworkKey(string title, string artist, string album)
    {
        return $"{title}\0{artist}\0{album}";
    }

    private static string BuildArtworkCacheRelativePath(string artworkKey)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(artworkKey));
        var hex = Convert.ToHexString(hash.AsSpan(0, ArtworkHashBytes)).ToLowerInvariant();
        return $"cache/art-{hex}.jpg";
    }

    private void PruneArtworkCache()
    {
        try
        {
            var cacheDir = Path.Combine(_pluginDir, "cache");
            if (!Directory.Exists(cacheDir))
            {
                return;
            }

            string? protectedFullPath = null;
            if (!string.IsNullOrEmpty(_lastArtworkKey))
            {
                protectedFullPath = Path.GetFullPath(
                    Path.Combine(_pluginDir, BuildArtworkCacheRelativePath(_lastArtworkKey)));
            }

            var ageCutoff = DateTime.UtcNow.AddDays(-MaxArtworkAgeDays);
            var tmpCutoff = DateTime.UtcNow.AddHours(-ArtworkTmpMaxAgeHours);
            var removed = 0;

            foreach (var tmpPath in Directory.GetFiles(cacheDir, "art-*.tmp"))
            {
                try
                {
                    if (File.GetLastWriteTimeUtc(tmpPath) < tmpCutoff)
                    {
                        File.Delete(tmpPath);
                        removed++;
                    }
                }
                catch
                {
                    // ignore per-file delete errors
                }
            }

            var survivors = new List<(string Path, DateTime WriteTimeUtc)>();
            foreach (var filePath in Directory.GetFiles(cacheDir, "art-*.jpg"))
            {
                var fullPath = Path.GetFullPath(filePath);
                if (protectedFullPath != null &&
                    fullPath.Equals(protectedFullPath, StringComparison.OrdinalIgnoreCase))
                {
                    survivors.Add((filePath, File.GetLastWriteTimeUtc(filePath)));
                    continue;
                }

                var writeTimeUtc = File.GetLastWriteTimeUtc(filePath);
                if (writeTimeUtc < ageCutoff)
                {
                    try
                    {
                        File.Delete(filePath);
                        removed++;
                    }
                    catch
                    {
                        // ignore per-file delete errors
                    }
                    continue;
                }

                survivors.Add((filePath, writeTimeUtc));
            }

            if (survivors.Count > MaxArtworkCacheFiles)
            {
                survivors.Sort((a, b) => a.WriteTimeUtc.CompareTo(b.WriteTimeUtc));
                var overflow = survivors.Count - MaxArtworkCacheFiles;
                for (var i = 0; i < overflow; i++)
                {
                    var candidate = survivors[i].Path;
                    var candidateFull = Path.GetFullPath(candidate);
                    if (protectedFullPath != null &&
                        candidateFull.Equals(protectedFullPath, StringComparison.OrdinalIgnoreCase))
                    {
                        continue;
                    }

                    try
                    {
                        File.Delete(candidate);
                        removed++;
                    }
                    catch
                    {
                        // ignore per-file delete errors
                    }
                }
            }

            var kept = Directory.GetFiles(cacheDir, "art-*.jpg").Length;
            if (removed > 0)
            {
                WriteEvent(new { @event = "log", message = $"[Spotify] artwork cache pruned: removed={removed}, kept={kept}" });
            }
        }
        catch
        {
            // cache cleanup is best-effort
        }
    }

    private void MaybeScheduleArtworkCachePrune()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (now - _lastArtworkPruneUtcMs >= ArtworkPruneDebounceMs)
        {
            PruneArtworkCache();
            _lastArtworkPruneUtcMs = now;
            return;
        }

        lock (_gate)
        {
            var delay = (int)Math.Max(1000, ArtworkPruneDebounceMs - (now - _lastArtworkPruneUtcMs));
            _artworkPruneTimer?.Dispose();
            _artworkPruneTimer = new Timer(_ =>
            {
                PruneArtworkCache();
                _lastArtworkPruneUtcMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }, null, delay, Timeout.Infinite);
        }
    }

    private static bool StatesEqual(SpotifyLocalStatePayload? a, SpotifyLocalStatePayload b)
    {
        if (a == null)
        {
            return false;
        }

        if (a.IsRunning != b.IsRunning || a.Error != b.Error)
        {
            return false;
        }

        if (a.Player.State != b.Player.State)
        {
            return false;
        }

        var aTrack = a.CurrentTrack;
        var bTrack = b.CurrentTrack;
        if (aTrack == null && bTrack == null)
        {
            return true;
        }

        if (aTrack == null || bTrack == null)
        {
            return false;
        }

        return aTrack.Title == bTrack.Title
            && aTrack.Artist == bTrack.Artist
            && aTrack.Album == bTrack.Album
            && aTrack.ArtworkPath == bTrack.ArtworkPath;
    }

    private async Task<SpotifyLocalStatePayload> BuildStateAsync()
    {
        var session = await GetOrRefreshSessionAsync();
        if (session == null)
        {
            return new SpotifyLocalStatePayload(
                DateTime.UtcNow.ToString("o"),
                false,
                new PlayerStatePayload("unknown", 0, 0),
                null,
                "No Spotify media session found"
            );
        }

        var mediaProps = await session.TryGetMediaPropertiesAsync();
        return BuildStateFromSession(session, mediaProps);
    }

    private SpotifyLocalStatePayload BuildStateFromSession(
        GlobalSystemMediaTransportControlsSession session,
        GlobalSystemMediaTransportControlsSessionMediaProperties? mediaProps)
    {
        var playbackInfo = session.GetPlaybackInfo();
        var (positionMs, durationMs) = (0L, 0L);

        var playbackStatus = playbackInfo?.PlaybackStatus switch
        {
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing => "playing",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Paused => "paused",
            GlobalSystemMediaTransportControlsSessionPlaybackStatus.Stopped => "stopped",
            _ => "unknown"
        };

        var title = mediaProps?.Title ?? "";
        var artist = mediaProps?.Artist ?? "";
        var album = mediaProps?.AlbumTitle ?? "";
        var hasTrack = !string.IsNullOrWhiteSpace(title);

        if (!hasTrack && IsInTransportGrace() && _lastGoodState?.CurrentTrack != null)
        {
            var heldTrack = _lastGoodState.CurrentTrack;
            return new SpotifyLocalStatePayload(
                DateTime.UtcNow.ToString("o"),
                true,
                new PlayerStatePayload(playbackStatus, positionMs, durationMs),
                heldTrack,
                null
            );
        }

        CurrentTrackPayload? track = hasTrack
            ? new CurrentTrackPayload(
                title,
                artist,
                album,
                session.SourceAppUserModelId,
                ResolveArtworkPathForTrack(title, artist, album)
            )
            : null;

        return new SpotifyLocalStatePayload(
            DateTime.UtcNow.ToString("o"),
            hasTrack,
            new PlayerStatePayload(playbackStatus, positionMs, durationMs),
            track,
            null
        );
    }

    private string? ResolveArtworkPathForTrack(string title, string artist, string album)
    {
        var artworkKey = BuildArtworkKey(title, artist, album);
        if (artworkKey != _lastArtworkKey)
        {
            return null;
        }

        var relativePath = BuildArtworkCacheRelativePath(artworkKey);
        var cachePath = Path.Combine(_pluginDir, relativePath);
        return File.Exists(cachePath) ? relativePath : null;
    }

    private static Task<(long PositionMs, long DurationMs)> ReadTimelineAsync(
        GlobalSystemMediaTransportControlsSession _)
    {
        // Timeline API is not projected in this target SDK; progress is optional for Stream Deck keys
        return Task.FromResult((0L, 0L));
    }

    private static async Task<byte[]?> ReadThumbnailBytesAsync(
        Windows.Storage.Streams.IRandomAccessStreamReference thumbnail)
    {
        try
        {
            var stream = await thumbnail.OpenReadAsync();
            using var reader = new DataReader(stream);
            await reader.LoadAsync((uint)stream.Size);
            var bytes = new byte[stream.Size];
            reader.ReadBytes(bytes);
            return bytes;
        }
        catch
        {
            return null;
        }
    }

    private async Task<GlobalSystemMediaTransportControlsSession?> GetOrRefreshSessionAsync()
    {
        if (_manager == null)
        {
            _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
            BindManagerEvents(_manager);
        }

        lock (_gate)
        {
            if (_session != null)
            {
                return _session;
            }
        }

        var session = FindSpotifySession(_manager);
        lock (_gate)
        {
            _session = session;
            if (_session != null)
            {
                BindSessionEvents(_session);
            }
        }

        return session;
    }

    private GlobalSystemMediaTransportControlsSession? FindSpotifySession(
        GlobalSystemMediaTransportControlsSessionManager manager)
    {
        var filter = _filter.ToLowerInvariant();
        var sessions = manager.GetSessions();

        var match = sessions.FirstOrDefault(s =>
            s.SourceAppUserModelId.Contains(filter, StringComparison.OrdinalIgnoreCase));

        if (match != null)
        {
            return match;
        }

        var current = manager.GetCurrentSession();
        if (current != null &&
            current.SourceAppUserModelId.Contains(filter, StringComparison.OrdinalIgnoreCase))
        {
            return current;
        }

        return null;
    }

    private void Cleanup()
    {
        lock (_gate)
        {
            _debounceTimer?.Dispose();
            _pollTimer?.Dispose();
            foreach (var timer in _artworkRetryTimers)
            {
                timer?.Dispose();
            }

            _artworkPruneTimer?.Dispose();
        }

        _cts.Cancel();
        _cts.Dispose();
        _stateEmitLock.Dispose();
        _artworkEmitLock.Dispose();
    }

    private void WriteEvent(object payload)
    {
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        lock (_writeLock)
        {
            Console.Out.WriteLine(json);
            Console.Out.Flush();
        }
    }

    private void WriteResult(object payload)
    {
        var json = JsonSerializer.Serialize(payload, JsonOptions);
        Console.Error.WriteLine(json);
        Console.Error.Flush();
    }

    private sealed record DaemonCommand(
        [property: JsonPropertyName("id")] int? Id,
        [property: JsonPropertyName("cmd")] string Cmd
    );

    private sealed record SpotifyLocalStatePayload(
        string Timestamp,
        bool IsRunning,
        PlayerStatePayload Player,
        CurrentTrackPayload? CurrentTrack,
        string? Error
    );

    private sealed record PlayerStatePayload(
        string State,
        long PositionMs,
        long DurationMs
    );

    private sealed record CurrentTrackPayload(
        string Title,
        string Artist,
        string Album,
        string SourceAppId,
        string? ArtworkPath
    );
}
