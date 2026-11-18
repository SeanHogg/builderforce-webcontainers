// The host's entry point does nothing: the .NET process Worker drives it through `Exports`
// (Interop.cs) once the runtime is up. browser-wasm requires an executable main assembly.
namespace Bfwc.Host;

public static class Program
{
    public static void Main()
    {
    }
}
