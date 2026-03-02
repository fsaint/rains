/**
 * Web Search Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  handleWebSearch,
  handleNewsSearch,
  handleImageSearch,
  handleSuggest,
} from './handlers.js';
import type { ServerContext } from '../common/types.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Web Search Handlers', () => {
  const mockContext: ServerContext = {
    requestId: 'test-request-id',
    accessToken: 'test-brave-api-key',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleWebSearch', () => {
    it('should return web search results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: { original: 'test query' },
          web: {
            results: [
              {
                title: 'Test Result',
                url: 'https://example.com',
                description: 'A test result',
                age: '2 days ago',
                language: 'en',
              },
            ],
          },
        }),
      });

      const result = await handleWebSearch({ query: 'test query' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        query: 'test query',
        results: [
          {
            title: 'Test Result',
            url: 'https://example.com',
            description: 'A test result',
            age: '2 days ago',
            language: 'en',
          },
        ],
        total: 1,
      });
    });

    it('should limit count to 20', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await handleWebSearch({ query: 'test', count: 50 }, mockContext);

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('count')).toBe('20');
    });

    it('should pass optional parameters', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ web: { results: [] } }),
      });

      await handleWebSearch(
        {
          query: 'test',
          country: 'us',
          searchLang: 'en',
          safesearch: 'strict',
          freshness: 'pd',
        },
        mockContext
      );

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('country')).toBe('us');
      expect(url.searchParams.get('search_lang')).toBe('en');
      expect(url.searchParams.get('safesearch')).toBe('strict');
      expect(url.searchParams.get('freshness')).toBe('pd');
    });

    it('should throw error when API key is missing', async () => {
      const contextWithoutKey: ServerContext = { requestId: 'test' };

      await expect(handleWebSearch({ query: 'test' }, contextWithoutKey)).rejects.toThrow(
        'Brave API key not configured'
      );
    });

    it('should handle API errors', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      });

      await expect(handleWebSearch({ query: 'test' }, mockContext)).rejects.toThrow(
        'Brave API error (401): Unauthorized'
      );
    });
  });

  describe('handleNewsSearch', () => {
    it('should return news search results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: { original: 'breaking news' },
          news: {
            results: [
              {
                title: 'Breaking Story',
                url: 'https://news.example.com/story',
                description: 'A breaking news story',
                age: '1 hour ago',
                source: { name: 'News Site', url: 'https://news.example.com' },
                thumbnail: { src: 'https://news.example.com/thumb.jpg' },
              },
            ],
          },
        }),
      });

      const result = await handleNewsSearch({ query: 'breaking news' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        query: 'breaking news',
        results: [
          {
            title: 'Breaking Story',
            url: 'https://news.example.com/story',
            description: 'A breaking news story',
            age: '1 hour ago',
            source: 'News Site',
            sourceUrl: 'https://news.example.com',
            thumbnail: 'https://news.example.com/thumb.jpg',
          },
        ],
        total: 1,
      });
    });

    it('should handle missing source and thumbnail', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          news: {
            results: [
              {
                title: 'Story',
                url: 'https://example.com',
                description: 'Desc',
              },
            ],
          },
        }),
      });

      const result = await handleNewsSearch({ query: 'news' }, mockContext);

      expect(result.data.results[0].source).toBeUndefined();
      expect(result.data.results[0].thumbnail).toBeUndefined();
    });
  });

  describe('handleImageSearch', () => {
    it('should return image search results', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          query: { original: 'cats' },
          images: {
            results: [
              {
                title: 'Cute Cat',
                source: 'https://cats.example.com',
                thumbnail: { src: 'https://cats.example.com/thumb.jpg' },
                properties: {
                  url: 'https://cats.example.com/cat.jpg',
                  width: 800,
                  height: 600,
                  format: 'jpeg',
                },
              },
            ],
          },
        }),
      });

      const result = await handleImageSearch({ query: 'cats' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        query: 'cats',
        results: [
          {
            title: 'Cute Cat',
            sourceUrl: 'https://cats.example.com',
            imageUrl: 'https://cats.example.com/cat.jpg',
            thumbnailUrl: 'https://cats.example.com/thumb.jpg',
            width: 800,
            height: 600,
            format: 'jpeg',
          },
        ],
        total: 1,
      });
    });

    it('should use strict safesearch by default', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: { results: [] } }),
      });

      await handleImageSearch({ query: 'test' }, mockContext);

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('safesearch')).toBe('strict');
    });
  });

  describe('handleSuggest', () => {
    it('should return search suggestions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          suggestions: ['test suggestion 1', 'test suggestion 2'],
        }),
      });

      const result = await handleSuggest({ query: 'test' }, mockContext);

      expect(result.success).toBe(true);
      expect(result.data).toEqual({
        query: 'test',
        suggestions: ['test suggestion 1', 'test suggestion 2'],
      });
    });

    it('should limit count to 10', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ suggestions: [] }),
      });

      await handleSuggest({ query: 'test', count: 20 }, mockContext);

      const url = new URL(mockFetch.mock.calls[0][0]);
      expect(url.searchParams.get('count')).toBe('10');
    });

    it('should handle empty suggestions', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const result = await handleSuggest({ query: 'xyz' }, mockContext);

      expect(result.data.suggestions).toEqual([]);
    });
  });
});
