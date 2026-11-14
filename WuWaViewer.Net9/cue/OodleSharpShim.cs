using System.IO.Compression;
using System.Runtime.CompilerServices;

namespace OodleSharp
{
    public static class OodleDecompressor
    {
        public static bool TryDecompress(ReadOnlySpan<byte> source, Span<byte> destination, out int bytesWritten)
        {
            bytesWritten = 0;
            return false;
        }
    }
}

namespace System.Runtime.CompilerServices
{
    [InlineArray(3)]
    public struct InlineArray3<T>
    {
        private T _element0;
    }
}

namespace OffiUtils
{
    public enum CompressionAlgorithm
    {
        None = 0,
        Zlib,
        Gzip,
        Oodle,
        LZ4,
        LZO,
        Brotli,
        Zstd,
    }

    public delegate bool DecompressDelegate(ReadOnlySpan<byte> source, Span<byte> destination, out int bytesWritten);
    public delegate bool DecompressDelegate<in TState>(TState state, ReadOnlySpan<byte> source, Span<byte> destination, out int bytesWritten);

    public interface IDecompressor
    {
        bool TryDecompress(CompressionAlgorithm algorithm, ReadOnlySpan<byte> source, Span<byte> destination, out int bytesWritten);
    }

    internal sealed class MapDecompressor(Dictionary<CompressionAlgorithm, DecompressDelegate> map) : IDecompressor
    {
        internal Dictionary<CompressionAlgorithm, DecompressDelegate> Map => map;

        public bool TryDecompress(CompressionAlgorithm algorithm, ReadOnlySpan<byte> source, Span<byte> destination, out int bytesWritten)
        {
            if (map.TryGetValue(algorithm, out var fn))
                return fn(source, destination, out bytesWritten);
            bytesWritten = 0;
            return false;
        }
    }

    public sealed class DecompressorBuilder
    {
        private readonly Dictionary<CompressionAlgorithm, DecompressDelegate> _handlers = new();

        public static DecompressorBuilder Default => new DecompressorBuilder()
            .Add(CompressionAlgorithm.Zlib, static (source, destination, out written) =>
            {
                using var ms = new MemoryStream(source.ToArray());
                using var zs = new ZLibStream(ms, CompressionMode.Decompress);
                written = ReadAll(zs, destination);
                return written > 0;
            })
            .Add(CompressionAlgorithm.Gzip, static (source, destination, out written) =>
            {
                using var ms = new MemoryStream(source.ToArray());
                using var gs = new GZipStream(ms, CompressionMode.Decompress);
                written = ReadAll(gs, destination);
                return written > 0;
            })
            .Add(CompressionAlgorithm.Brotli, static (source, destination, out written) =>
                BrotliDecoder.TryDecompress(source, destination, out written));

        private static int ReadAll(Stream stream, Span<byte> destination)
        {
            int total = 0;
            while (total < destination.Length)
            {
                int read = stream.Read(destination[total..]);
                if (read == 0) break;
                total += read;
            }
            return total;
        }

        public DecompressorBuilder AddRange(IDecompressor decompressor, bool replace = false)
        {
            if (decompressor is MapDecompressor md)
            {
                foreach (var kv in md.Map)
                {
                    if (replace || !_handlers.ContainsKey(kv.Key))
                        _handlers[kv.Key] = kv.Value;
                }
            }
            return this;
        }

        public DecompressorBuilder Add(CompressionAlgorithm algorithm, DecompressDelegate handler, bool replace = false)
        {
            if (replace || !_handlers.ContainsKey(algorithm))
                _handlers[algorithm] = handler;
            return this;
        }

        public DecompressorBuilder Add<TState>(CompressionAlgorithm algorithm, TState state, DecompressDelegate<TState> handler, bool replace = false)
        {
            return Add(algorithm, (ReadOnlySpan<byte> src, Span<byte> dst, out int written) => handler(state, src, dst, out written), replace);
        }

        public IDecompressor Build() => new MapDecompressor(new Dictionary<CompressionAlgorithm, DecompressDelegate>(_handlers));
    }
}
