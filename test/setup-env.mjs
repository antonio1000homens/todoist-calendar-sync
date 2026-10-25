// Keep test fixtures isolated from environment-specific deployment config.
// Deploy workflows intentionally inject production profile routes/project IDs
// into every step, including `npm test`; those values do not belong in tests.
process.env.SYNC_PROFILE_CONFIG_JSON = JSON.stringify({
  home: {
    calendarId: 'home@example.test',
    channelId: 'test-home-channel',
    todoistRoute: '/todoist-home',
    todoistProjectId: 'test-home-project',
  },
  antonio: {
    calendarId: 'personal@example.test',
    channelId: 'test-personal-channel',
    todoistRoute: '/todoist-personal',
    todoistProjectId: 'test-personal-project',
  },
  work: {
    calendarId: 'work@example.test',
    channelId: 'test-work-channel',
    todoistRoute: '/todoist-work',
    todoistProjectId: 'test-work-project',
  },
});

// Repository modules capture the state table name during import. Set a test
// value in the preload step so tests that exercise newly added repository
// methods never fall through to a missing production configuration.
process.env.STATE_TABLE_NAME ||= 'test-state';
