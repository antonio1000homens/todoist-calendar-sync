process.env.SYNC_PROFILE_CONFIG_JSON ||= JSON.stringify({
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
