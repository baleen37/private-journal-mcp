import { resolveEmbeddingRuntimePaths } from '../src/embedding-runtime';

describe('resolveEmbeddingRuntimePaths', () => {
  it('uses XDG runtime directory and keeps the socket path short', () => {
    const paths = resolveEmbeddingRuntimePaths(
      { XDG_RUNTIME_DIR: '/tmp/runtime-jito' }, 'linux', 501,
    );

    expect(paths.directory).toBe('/tmp/runtime-jito/private-journal');
    expect(paths.socketPath.length).toBeLessThan(100);
  });
});
