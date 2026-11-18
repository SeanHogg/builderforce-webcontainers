// Console.Out and Console.Error to the Worker's stdout/stderr messages, a line at a time (and on Flush).
// Standard input is not forwarded (browser-wasm's Console has no input).
using System.Text;

namespace Bfwc.Host;

internal static class JsConsole
{
    static LineWriter? stdout;
    static LineWriter? stderr;

    internal static void Install()
    {
        stdout ??= new LineWriter(Js.Stdout);
        stderr ??= new LineWriter(Js.Stderr);
        Console.SetOut(stdout);
        Console.SetError(stderr);
    }

    internal static void Flush()
    {
        stdout?.Flush();
        stderr?.Flush();
    }

    sealed class LineWriter(Action<string> sink) : TextWriter
    {
        readonly StringBuilder buffer = new();

        public override Encoding Encoding => Encoding.UTF8;

        public override void Write(char value)
        {
            buffer.Append(value);
            if (value == '\n') Flush();
        }

        public override void Write(string? value)
        {
            if (string.IsNullOrEmpty(value)) return;
            buffer.Append(value);
            if (value.Contains('\n')) Flush();
        }

        public override void Write(char[] buffer, int index, int count) => Write(new string(buffer, index, count));

        public override void WriteLine(string? value)
        {
            buffer.Append(value).Append('\n');
            Flush();
        }

        public override void Flush()
        {
            if (buffer.Length == 0) return;
            var text = buffer.ToString();
            buffer.Clear();
            sink(text);
        }
    }
}
