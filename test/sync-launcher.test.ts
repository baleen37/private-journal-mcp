const mockSpawn = jest.fn();

jest.mock('child_process', () => ({ spawn: mockSpawn }));

import { launchBackgroundSync } from '../src/sync-launcher';

describe('launchBackgroundSync', () => {
  beforeEach(() => mockSpawn.mockReset());

  it('detaches sync with the selected data path and remote', () => {
    const unref = jest.fn();
    mockSpawn.mockReturnValue({ unref });

    launchBackgroundSync('/tmp/private-journal', 'https://example.test/journal.git');

    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/index\.js$/), 'sync'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: expect.objectContaining({
          PRIVATE_JOURNAL_PATH: '/tmp/private-journal',
          PRIVATE_JOURNAL_GIT_REMOTE: 'https://example.test/journal.git',
        }),
      }),
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });
});
