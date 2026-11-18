// A Python extension for the runtime's tests, shaped like the @webdit/torch
// bridge: a JS engine module, a Python package over it, and what it provides.
export async function createTinyTorch() {
  const engine = { calls: 0 };
  return {
    jsModules: {
      _tiny_engine: {
        add(a, b) {
          engine.calls += 1;
          return a + b;
        },
        calls: () => engine.calls,
      },
    },
    files: {
      'torch/__init__.py': 'import _tiny_engine\n__version__ = "0.0-tiny"\n\ndef add(a, b):\n    return _tiny_engine.add(a, b)\n',
    },
    root: '/opt/tiny-torch',
    provides: ['torch'],
  };
}
