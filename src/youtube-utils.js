/**
 * YouTube URL parsing and video ID extraction utilities.
 */

/**
 * Extract video ID from various YouTube URL formats.
 * Supports: youtube.com/watch, youtu.be, youtube.com/shorts, youtube.com/embed, youtube.com/v/
 */
export function extractVideoId(url) {
    if (!url || typeof url !== 'string') return null;
    const trimmed = url.trim();

    // Already a video ID (11 chars alphanumeric + dash + underscore)
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

    try {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.replace('www.', '');

        // youtube.com/watch?v=VIDEO_ID
        if (host.includes('youtube.com') && parsed.pathname === '/watch') {
            return parsed.searchParams.get('v') || null;
        }

        // youtu.be/VIDEO_ID
        if (host === 'youtu.be') {
            return parsed.pathname.slice(1).split('/')[0] || null;
        }

        // youtube.com/shorts/VIDEO_ID
        if (host.includes('youtube.com') && parsed.pathname.startsWith('/shorts/')) {
            return parsed.pathname.split('/')[2] || null;
        }

        // youtube.com/embed/VIDEO_ID
        if (host.includes('youtube.com') && parsed.pathname.startsWith('/embed/')) {
            return parsed.pathname.split('/')[2] || null;
        }

        // youtube.com/v/VIDEO_ID
        if (host.includes('youtube.com') && parsed.pathname.startsWith('/v/')) {
            return parsed.pathname.split('/')[2] || null;
        }
    } catch {
        // Not a valid URL
    }

    return null;
}

/**
 * Detect URL type: video, playlist, channel, or unknown.
 */
export function detectUrlType(url) {
    if (!url) return 'unknown';
    const trimmed = url.trim();

    // Direct video ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return 'video';

    try {
        const parsed = new URL(trimmed);
        const host = parsed.hostname.replace('www.', '');

        if (!host.includes('youtube.com') && host !== 'youtu.be') return 'unknown';

        // Playlist
        if (parsed.searchParams.get('list')) return 'playlist';
        if (parsed.pathname.startsWith('/playlist')) return 'playlist';

        // Channel
        if (parsed.pathname.startsWith('/@')) return 'channel';
        if (parsed.pathname.startsWith('/channel/')) return 'channel';
        if (parsed.pathname.startsWith('/c/')) return 'channel';
        if (parsed.pathname.startsWith('/user/')) return 'channel';

        // Video
        if (parsed.pathname === '/watch' && parsed.searchParams.get('v')) return 'video';
        if (host === 'youtu.be') return 'video';
        if (parsed.pathname.startsWith('/shorts/')) return 'video';
        if (parsed.pathname.startsWith('/embed/')) return 'video';

    } catch {}

    return 'unknown';
}

/**
 * Extract playlist ID from URL.
 */
export function extractPlaylistId(url) {
    try {
        const parsed = new URL(url.trim());
        return parsed.searchParams.get('list') || null;
    } catch {
        return null;
    }
}

/**
 * Extract channel handle or ID from URL.
 */
export function extractChannelId(url) {
    try {
        const parsed = new URL(url.trim());
        const path = parsed.pathname;

        if (path.startsWith('/@')) return path.split('/')[1]; // @handle
        if (path.startsWith('/channel/')) return path.split('/')[2]; // UCxxxxxx
        if (path.startsWith('/c/')) return path.split('/')[2]; // custom name
        if (path.startsWith('/user/')) return path.split('/')[2]; // legacy user

        return null;
    } catch {
        return null;
    }
}

/**
 * Parse XML transcript response into segments.
 * Supports both formats:
 *   Old: <text start="1.23" dur="4.56">text</text>
 *   New (ANDROID): <p t="1230" d="4560">text</p>  (milliseconds)
 */
export function parseTranscriptXml(xml) {
    const segments = [];

    // Try new format first: <p t="ms" d="ms">text</p>
    const newRegex = /<p\s+t="([^"]+)"\s+d="([^"]+)"[^>]*>([\s\S]*?)<\/p>/gi;
    let match;
    let isNewFormat = false;

    while ((match = newRegex.exec(xml)) !== null) {
        isNewFormat = true;
        const start = parseInt(match[1]) / 1000; // ms to seconds
        const duration = parseInt(match[2]) / 1000;
        let text = decodeXmlEntities(match[3]);
        if (text) {
            segments.push({ start, duration, text });
        }
    }

    if (isNewFormat) return segments;

    // Fall back to old format: <text start="s" dur="s">text</text>
    const oldRegex = /<text\s+start="([^"]+)"\s+dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/gi;
    while ((match = oldRegex.exec(xml)) !== null) {
        const start = parseFloat(match[1]);
        const duration = parseFloat(match[2]);
        let text = decodeXmlEntities(match[3]);
        if (text) {
            segments.push({ start, duration, text });
        }
    }

    return segments;
}

function decodeXmlEntities(text) {
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/<[^>]+>/g, '') // strip inner HTML
        .replace(/\n/g, ' ')
        .trim();
}

/**
 * Convert segments array to full text string.
 */
export function segmentsToFullText(segments) {
    return segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Format seconds to HH:MM:SS or MM:SS.
 */
export function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
}
