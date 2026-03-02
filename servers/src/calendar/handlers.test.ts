/**
 * Google Calendar Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerContext } from '../common/types.js';

// Mock googleapis
vi.mock('googleapis', () => {
  const mockCalendar = {
    events: {
      list: vi.fn(),
      get: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    calendarList: {
      list: vi.fn(),
    },
    freebusy: {
      query: vi.fn(),
    },
  };

  return {
    google: {
      auth: {
        OAuth2: vi.fn().mockImplementation(() => ({
          setCredentials: vi.fn(),
        })),
      },
      calendar: vi.fn(() => mockCalendar),
    },
  };
});

// Import after mocking
import { google } from 'googleapis';
import {
  handleListEvents,
  handleGetEvent,
  handleSearchEvents,
  handleCreateEvent,
  handleUpdateEvent,
  handleDeleteEvent,
  handleListCalendars,
  handleGetFreeBusy,
} from './handlers.js';

describe('Calendar Handlers', () => {
  const mockContext: ServerContext = {
    requestId: 'test-request-id',
    accessToken: 'test-access-token',
  };

  let mockCalendarClient: ReturnType<typeof google.calendar>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCalendarClient = google.calendar({ version: 'v3' });
  });

  describe('handleListEvents', () => {
    it('should list events', async () => {
      vi.mocked(mockCalendarClient.events.list).mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'event1',
              summary: 'Meeting',
              start: { dateTime: '2024-01-01T10:00:00Z' },
              end: { dateTime: '2024-01-01T11:00:00Z' },
            },
            {
              id: 'event2',
              summary: 'Lunch',
              start: { dateTime: '2024-01-01T12:00:00Z' },
              end: { dateTime: '2024-01-01T13:00:00Z' },
            },
          ],
          nextPageToken: 'next-token',
          summary: 'My Calendar',
          timeZone: 'America/Los_Angeles',
        },
      } as never);

      const result = await handleListEvents({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.events).toHaveLength(2);
      expect(result.data.events[0].summary).toBe('Meeting');
      expect(result.data.nextPageToken).toBe('next-token');
    });

    it('should use custom calendar', async () => {
      vi.mocked(mockCalendarClient.events.list).mockResolvedValueOnce({
        data: { items: [] },
      } as never);

      await handleListEvents({ calendarId: 'work@example.com' }, mockContext);

      expect(mockCalendarClient.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ calendarId: 'work@example.com' })
      );
    });

    it('should limit maxResults', async () => {
      vi.mocked(mockCalendarClient.events.list).mockResolvedValueOnce({
        data: { items: [] },
      } as never);

      await handleListEvents({ maxResults: 500 }, mockContext);

      expect(mockCalendarClient.events.list).toHaveBeenCalledWith(
        expect.objectContaining({ maxResults: 250 })
      );
    });

    it('should handle all-day events', async () => {
      vi.mocked(mockCalendarClient.events.list).mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'event1',
              summary: 'Holiday',
              start: { date: '2024-01-01' },
              end: { date: '2024-01-02' },
            },
          ],
        },
      } as never);

      const result = await handleListEvents({}, mockContext);

      expect(result.data.events[0].allDay).toBe(true);
      expect(result.data.events[0].start).toBe('2024-01-01');
    });

    it('should throw error when no access token', async () => {
      const contextWithoutToken: ServerContext = { requestId: 'test' };

      await expect(handleListEvents({}, contextWithoutToken)).rejects.toThrow(
        'No access token available'
      );
    });
  });

  describe('handleGetEvent', () => {
    it('should get event details', async () => {
      vi.mocked(mockCalendarClient.events.get).mockResolvedValueOnce({
        data: {
          id: 'event1',
          summary: 'Team Meeting',
          description: 'Weekly sync',
          location: 'Conference Room A',
          start: { dateTime: '2024-01-01T10:00:00Z' },
          end: { dateTime: '2024-01-01T11:00:00Z' },
          attendees: [
            { email: 'user1@example.com', responseStatus: 'accepted' },
            { email: 'user2@example.com', responseStatus: 'tentative' },
          ],
          hangoutLink: 'https://meet.google.com/xyz',
        },
      } as never);

      const result = await handleGetEvent({ eventId: 'event1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.summary).toBe('Team Meeting');
      expect(result.data.attendees).toHaveLength(2);
      expect(result.data.hangoutLink).toBe('https://meet.google.com/xyz');
    });
  });

  describe('handleSearchEvents', () => {
    it('should search events by query', async () => {
      vi.mocked(mockCalendarClient.events.list).mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'event1',
              summary: 'Project Review Meeting',
              start: { dateTime: '2024-01-01T14:00:00Z' },
              end: { dateTime: '2024-01-01T15:00:00Z' },
            },
          ],
        },
      } as never);

      const result = await handleSearchEvents({ query: 'project review' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.query).toBe('project review');
      expect(result.data.events).toHaveLength(1);
      expect(result.data.total).toBe(1);
    });

    it('should filter by time range', async () => {
      vi.mocked(mockCalendarClient.events.list).mockResolvedValueOnce({
        data: { items: [] },
      } as never);

      await handleSearchEvents(
        {
          query: 'meeting',
          timeMin: '2024-01-01T00:00:00Z',
          timeMax: '2024-01-31T23:59:59Z',
        },
        mockContext
      );

      expect(mockCalendarClient.events.list).toHaveBeenCalledWith(
        expect.objectContaining({
          q: 'meeting',
          timeMin: '2024-01-01T00:00:00Z',
          timeMax: '2024-01-31T23:59:59Z',
        })
      );
    });
  });

  describe('handleCreateEvent', () => {
    it('should create event with basic info', async () => {
      vi.mocked(mockCalendarClient.events.insert).mockResolvedValueOnce({
        data: {
          id: 'new-event-id',
          summary: 'New Meeting',
          start: { dateTime: '2024-01-01T10:00:00Z' },
          end: { dateTime: '2024-01-01T11:00:00Z' },
          htmlLink: 'https://calendar.google.com/event/xyz',
        },
      } as never);

      const result = await handleCreateEvent(
        {
          summary: 'New Meeting',
          startTime: '2024-01-01T10:00:00Z',
          endTime: '2024-01-01T11:00:00Z',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('Event created successfully');
    });

    it('should create all-day event', async () => {
      vi.mocked(mockCalendarClient.events.insert).mockResolvedValueOnce({
        data: {
          id: 'new-event-id',
          summary: 'Holiday',
          start: { date: '2024-01-01' },
          end: { date: '2024-01-02' },
        },
      } as never);

      await handleCreateEvent(
        {
          summary: 'Holiday',
          allDay: true,
          startDate: '2024-01-01',
          endDate: '2024-01-02',
        },
        mockContext
      );

      expect(mockCalendarClient.events.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            start: { date: '2024-01-01' },
            end: { date: '2024-01-02' },
          }),
        })
      );
    });

    it('should add attendees', async () => {
      vi.mocked(mockCalendarClient.events.insert).mockResolvedValueOnce({
        data: { id: 'new-event-id', summary: 'Team Sync' },
      } as never);

      await handleCreateEvent(
        {
          summary: 'Team Sync',
          startTime: '2024-01-01T10:00:00Z',
          attendees: ['user1@example.com', 'user2@example.com'],
        },
        mockContext
      );

      expect(mockCalendarClient.events.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            attendees: [{ email: 'user1@example.com' }, { email: 'user2@example.com' }],
          }),
        })
      );
    });

    it('should create with conference data', async () => {
      vi.mocked(mockCalendarClient.events.insert).mockResolvedValueOnce({
        data: {
          id: 'new-event-id',
          hangoutLink: 'https://meet.google.com/abc',
        },
      } as never);

      await handleCreateEvent(
        {
          summary: 'Video Call',
          startTime: '2024-01-01T10:00:00Z',
          conferenceData: true,
        },
        mockContext
      );

      expect(mockCalendarClient.events.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          conferenceDataVersion: 1,
        })
      );
    });
  });

  describe('handleUpdateEvent', () => {
    it('should update event summary', async () => {
      vi.mocked(mockCalendarClient.events.get).mockResolvedValueOnce({
        data: {
          id: 'event1',
          summary: 'Old Title',
          start: { dateTime: '2024-01-01T10:00:00Z' },
          end: { dateTime: '2024-01-01T11:00:00Z' },
        },
      } as never);

      vi.mocked(mockCalendarClient.events.update).mockResolvedValueOnce({
        data: {
          id: 'event1',
          summary: 'New Title',
        },
      } as never);

      const result = await handleUpdateEvent(
        { eventId: 'event1', summary: 'New Title' },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.message).toBe('Event updated successfully');
    });

    it('should update event time', async () => {
      vi.mocked(mockCalendarClient.events.get).mockResolvedValueOnce({
        data: {
          id: 'event1',
          summary: 'Meeting',
          start: { dateTime: '2024-01-01T10:00:00Z' },
          end: { dateTime: '2024-01-01T11:00:00Z' },
        },
      } as never);

      vi.mocked(mockCalendarClient.events.update).mockResolvedValueOnce({
        data: { id: 'event1' },
      } as never);

      await handleUpdateEvent(
        {
          eventId: 'event1',
          startTime: '2024-01-01T14:00:00Z',
          endTime: '2024-01-01T15:00:00Z',
        },
        mockContext
      );

      expect(mockCalendarClient.events.update).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            start: { dateTime: '2024-01-01T14:00:00Z' },
            end: { dateTime: '2024-01-01T15:00:00Z' },
          }),
        })
      );
    });
  });

  describe('handleDeleteEvent', () => {
    it('should delete event', async () => {
      vi.mocked(mockCalendarClient.events.delete).mockResolvedValueOnce({} as never);

      const result = await handleDeleteEvent({ eventId: 'event1' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.eventId).toBe('event1');
      expect(result.data.message).toBe('Event deleted successfully');
    });

    it('should use sendUpdates parameter', async () => {
      vi.mocked(mockCalendarClient.events.delete).mockResolvedValueOnce({} as never);

      await handleDeleteEvent(
        { eventId: 'event1', sendUpdates: 'none' },
        mockContext
      );

      expect(mockCalendarClient.events.delete).toHaveBeenCalledWith(
        expect.objectContaining({ sendUpdates: 'none' })
      );
    });
  });

  describe('handleListCalendars', () => {
    it('should list calendars', async () => {
      vi.mocked(mockCalendarClient.calendarList.list).mockResolvedValueOnce({
        data: {
          items: [
            {
              id: 'primary',
              summary: 'My Calendar',
              primary: true,
              accessRole: 'owner',
              backgroundColor: '#1a73e8',
              timeZone: 'America/Los_Angeles',
            },
            {
              id: 'work@example.com',
              summary: 'Work',
              primary: false,
              accessRole: 'reader',
            },
          ],
        },
      } as never);

      const result = await handleListCalendars({}, mockContext);

      expect(result.success).toBe(true);
      expect(result.data.calendars).toHaveLength(2);
      expect(result.data.calendars[0].primary).toBe(true);
    });

    it('should show hidden calendars if requested', async () => {
      vi.mocked(mockCalendarClient.calendarList.list).mockResolvedValueOnce({
        data: { items: [] },
      } as never);

      await handleListCalendars({ showHidden: true }, mockContext);

      expect(mockCalendarClient.calendarList.list).toHaveBeenCalledWith(
        expect.objectContaining({ showHidden: true })
      );
    });
  });

  describe('handleGetFreeBusy', () => {
    it('should get free/busy info', async () => {
      vi.mocked(mockCalendarClient.freebusy.query).mockResolvedValueOnce({
        data: {
          calendars: {
            primary: {
              busy: [
                { start: '2024-01-01T10:00:00Z', end: '2024-01-01T11:00:00Z' },
                { start: '2024-01-01T14:00:00Z', end: '2024-01-01T15:00:00Z' },
              ],
            },
          },
        },
      } as never);

      const result = await handleGetFreeBusy(
        {
          timeMin: '2024-01-01T00:00:00Z',
          timeMax: '2024-01-01T23:59:59Z',
        },
        mockContext
      );

      expect(result.success).toBe(true);
      expect(result.data.calendars.primary).toHaveLength(2);
    });

    it('should query multiple calendars', async () => {
      vi.mocked(mockCalendarClient.freebusy.query).mockResolvedValueOnce({
        data: {
          calendars: {
            primary: { busy: [] },
            'work@example.com': { busy: [] },
          },
        },
      } as never);

      await handleGetFreeBusy(
        {
          timeMin: '2024-01-01T00:00:00Z',
          timeMax: '2024-01-01T23:59:59Z',
          calendarIds: ['primary', 'work@example.com'],
        },
        mockContext
      );

      expect(mockCalendarClient.freebusy.query).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: expect.objectContaining({
            items: [{ id: 'primary' }, { id: 'work@example.com' }],
          }),
        })
      );
    });
  });
});
