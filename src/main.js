import { Actor } from 'apify';
import { HttpCrawler, log } from 'crawlee';
import { gotScraping } from 'got-scraping';
import {
    extractVideoId,
    detectUrlType,
    extractPlaylistId,
    extractChannelId,
    parseTranscriptXml,
    segmentsToFullText,
    formatTime,
} from './youtube-utils.js';

const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

await Actor.init();

try {
    const input = await Actor.getInput() ?? {};
    const {
        urls = [],
        language = 'en',
        includeTimestamps = true,
        outputFormat = 'both',
        maxVideos = 50,
        includeMetadata = true,
        maxConcurrency = 5,
        proxyConfiguration,
    } = input;

    if (!urls.length) {
        throw new Error('No URLs provided. Add at least one YouTube video, playlist, or channel URL.');
    }

    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log.info('  YouTube Transcript & Subtitles Scraper');
    log.info('  No API key required | PPE pricing');
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log.info('Config:', {
        urls: urls.length,
        language,
        outputFormat,
        maxVideos,
        includeMetadata,
    });

    // PPE setup
    let isPPE = false;
    try {
        const pricingInfo = Actor.getChargingManager().getPricingInfo();
        isPPE = pricingInfo.isPayPerEvent;
        if (isPPE) log.info('PPE mode active');
    } catch {
        log.info('Running in free/test mode');
    }

    if (isPPE) {
        try { await Actor.charge({ eventName: 'actor-start', count: 1 }); } catch {}
    }

    const proxyConfig = proxyConfiguration?.useApifyProxy
        ? await Actor.createProxyConfiguration(proxyConfiguration)
        : undefined;

    const stats = { transcripts: 0, errors: 0, noTranscript: 0 };

    // Phase 1: Resolve all URLs to video IDs
    const videoIds = new Set();
    const playlistsToResolve = [];
    const channelsToResolve = [];

    for (const url of urls) {
        const type = detectUrlType(url);
        if (type === 'video') {
            const vid = extractVideoId(url);
            if (vid) videoIds.add(vid);
        } else if (type === 'playlist') {
            playlistsToResolve.push(url);
        } else if (type === 'channel') {
            channelsToResolve.push(url);
        } else {
            const vid = extractVideoId(url);
            if (vid) videoIds.add(vid);
            else log.warning(`Could not parse URL: ${url}`);
        }
    }

    // Phase 1b: Resolve playlists and channels
    if (playlistsToResolve.length || channelsToResolve.length) {
        log.info(`Resolving ${playlistsToResolve.length} playlists + ${channelsToResolve.length} channels...`);
        const resolveRequests = [];

        for (const url of playlistsToResolve) {
            const listId = extractPlaylistId(url);
            if (listId) {
                resolveRequests.push({
                    url: `https://www.youtube.com/playlist?list=${listId}`,
                    userData: { type: 'playlist' },
                });
            }
        }

        for (const url of channelsToResolve) {
            const channelId = extractChannelId(url);
            if (channelId) {
                const channelUrl = channelId.startsWith('@')
                    ? `https://www.youtube.com/${channelId}/videos`
                    : `https://www.youtube.com/channel/${channelId}/videos`;
                resolveRequests.push({
                    url: channelUrl,
                    userData: { type: 'channel' },
                });
            }
        }

        if (resolveRequests.length) {
            const resolver = new HttpCrawler({
                proxyConfiguration: proxyConfig,
                maxConcurrency: 3,
                maxRequestRetries: 2,
                async requestHandler({ body }) {
                    const html = typeof body === 'string' ? body : body.toString('utf-8');
                    const beforeCount = videoIds.size;

                    // Method 1: Extract from ytInitialData JSON (most reliable)
                    const initDataMatch = html.match(/var\s+ytInitialData\s*=\s*(\{.+?\});\s*<\/script/s);
                    if (initDataMatch) {
                        try {
                            const initData = JSON.parse(initDataMatch[1]);
                            const jsonStr = JSON.stringify(initData);
                            // Find all videoId fields in the JSON
                            const videoIdRegex = /"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"/g;
                            let m;
                            while ((m = videoIdRegex.exec(jsonStr)) !== null) {
                                if (videoIds.size < maxVideos) videoIds.add(m[1]);
                            }
                        } catch {}
                    }

                    // Method 2: Regex fallback for /watch?v= links
                    const vidRegex = /\/watch\?v=([a-zA-Z0-9_-]{11})/g;
                    let m;
                    while ((m = vidRegex.exec(html)) !== null) {
                        if (videoIds.size < maxVideos) videoIds.add(m[1]);
                    }

                    // Method 3: Extract videoId from any JSON-like pattern in HTML
                    const jsonVidRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
                    while ((m = jsonVidRegex.exec(html)) !== null) {
                        if (videoIds.size < maxVideos) videoIds.add(m[1]);
                    }

                    log.info(`Resolved: found ${videoIds.size} total video IDs (+${videoIds.size - beforeCount} new)`);
                },
                async failedRequestHandler({ request }, error) {
                    log.warning(`Failed to resolve ${request.url}: ${error.message}`);
                },
            });
            await resolver.run(resolveRequests);
        }
    }

    const allVideoIds = [...videoIds].slice(0, maxVideos);
    log.info(`Processing ${allVideoIds.length} videos...`);

    // Phase 2: For each video, call InnerTube player API + fetch caption XML
    // Use HttpCrawler to fetch video pages (for metadata), then InnerTube for captions
    const videoRequests = allVideoIds.map(vid => ({
        url: `https://www.youtube.com/watch?v=${vid}`,
        userData: { videoId: vid },
    }));

    const mainCrawler = new HttpCrawler({
        proxyConfiguration: proxyConfig,
        maxConcurrency,
        maxRequestRetries: 3,
        requestHandlerTimeoutSecs: 60,
        async requestHandler({ request, body, response }) {
            const { videoId } = request.userData;
            const html = typeof body === 'string' ? body : body.toString('utf-8');

            // Extract cookies from the video page response for InnerTube auth
            const pageCookies = extractCookiesFromResponse(response);

            // Extract metadata from page HTML
            let metadata = {};
            if (includeMetadata) {
                const playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/s);
                if (playerMatch) {
                    try {
                        const pagePlayerData = JSON.parse(playerMatch[1]);
                        metadata = extractMetadata(pagePlayerData, html);
                    } catch {}
                }
            }

            // Extract API key from page (more reliable than hardcoded)
            const apiKeyMatch = html.match(/"INNERTUBE_API_KEY":\s*"([^"]+)"/);
            const pageApiKey = apiKeyMatch ? apiKeyMatch[1] : INNERTUBE_API_KEY;

            // Call InnerTube player API to get caption URLs without &exp=xpe
            let playerData;
            try {
                playerData = await fetchInnertubePlayer(videoId, proxyConfig, pageCookies, pageApiKey);
            } catch (err) {
                log.warning(`InnerTube failed for ${videoId}: ${err.message} (try enabling proxy for music/VEVO videos)`);
                stats.noTranscript++;
                await Actor.pushData({
                    videoId,
                    videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
                    ...metadata,
                    hasTranscript: false,
                    error: 'Video requires proxy or authentication (music/VEVO)',
                    availableLanguages: [],
                    scrapedAt: new Date().toISOString(),
                });
                return;
            }

            // Enrich metadata from InnerTube player data (more reliable than page HTML)
            if (includeMetadata) {
                const innertubeMetadata = extractMetadata(playerData, html);
                // Merge: InnerTube data fills gaps left by page HTML extraction
                for (const [key, value] of Object.entries(innertubeMetadata)) {
                    if (value && !metadata[key]) metadata[key] = value;
                }
            }

            const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

            const availableLanguages = (captionTracks || []).map(t => ({
                code: t.languageCode,
                name: t.name?.simpleText || t.name?.runs?.[0]?.text || t.languageCode,
                isAutoGenerated: t.kind === 'asr',
            }));

            if (!captionTracks || captionTracks.length === 0) {
                log.info(`No captions for ${videoId}`);
                stats.noTranscript++;
                if (includeMetadata) {
                    await Actor.pushData({
                        videoId,
                        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
                        ...metadata,
                        hasTranscript: false,
                        availableLanguages: [],
                        scrapedAt: new Date().toISOString(),
                    });
                }
                return;
            }

            // Find best track (prefer manual, then any matching lang, then en, then first)
            let selectedTrack = captionTracks.find(t => t.languageCode === language && t.kind !== 'asr');
            if (!selectedTrack) selectedTrack = captionTracks.find(t => t.languageCode === language);
            if (!selectedTrack) selectedTrack = captionTracks.find(t => t.languageCode === 'en');
            if (!selectedTrack) selectedTrack = captionTracks[0];

            let captionUrl = selectedTrack.baseUrl;
            if (!captionUrl) {
                log.warning(`No caption URL for ${videoId}`);
                stats.noTranscript++;
                return;
            }

            // Remove fmt=srv3 if present (we want default XML format)
            captionUrl = captionUrl.replace('&fmt=srv3', '');

            log.info(`Found ${captionTracks.length} tracks for ${videoId}, fetching ${selectedTrack.languageCode}`);

            // Fetch caption XML
            let xml = '';
            try {
                const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
                const gotOptions = {
                    url: captionUrl,
                    headers: {
                        'User-Agent': 'com.google.android.youtube/20.10.38',
                    },
                    responseType: 'text',
                    timeout: { request: 15000 },
                };
                if (proxyUrl) gotOptions.proxyUrl = proxyUrl;
                const captionResponse = await gotScraping(gotOptions);
                xml = captionResponse.body || '';
                log.info(`Caption XML for ${videoId}: ${xml.length} chars`);
            } catch (err) {
                log.warning(`Failed to fetch caption XML for ${videoId}: ${err.message}`);
                stats.errors++;
                return;
            }

            // Save debug for first transcript
            if (stats.transcripts === 0) {
                try {
                    await Actor.setValue('DEBUG_CAPTION_XML', xml.substring(0, 5000), { contentType: 'text/plain' });
                } catch {}
            }

            const segments = parseTranscriptXml(xml);
            if (segments.length === 0) {
                log.warning(`Empty transcript for ${videoId}`);
                log.info(`XML preview: ${xml.substring(0, 500)}`);
                stats.noTranscript++;
                return;
            }

            const fullText = segmentsToFullText(segments);
            log.info(`Transcript: ${videoId} -> ${segments.length} segments, ${fullText.length} chars`);

            const output = {
                videoId,
                videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
                language: selectedTrack.languageCode,
                languageName: selectedTrack.name?.simpleText || selectedTrack.name?.runs?.[0]?.text || selectedTrack.languageCode,
                isAutoGenerated: selectedTrack.kind === 'asr',
                availableLanguages,
                hasTranscript: true,
            };

            if (includeMetadata) {
                Object.assign(output, metadata);
            }

            if (outputFormat === 'full-text' || outputFormat === 'both') {
                output.transcriptText = fullText;
                output.charCount = fullText.length;
                output.wordCount = fullText.split(/\s+/).length;
            }

            if (outputFormat === 'segments' || outputFormat === 'both') {
                output.segments = includeTimestamps
                    ? segments.map(s => ({
                        text: s.text,
                        start: s.start,
                        duration: s.duration,
                        startFormatted: formatTime(s.start),
                    }))
                    : segments.map(s => ({ text: s.text }));
                output.segmentCount = segments.length;
            }

            output.scrapedAt = new Date().toISOString();

            await Actor.pushData(output);
            stats.transcripts++;

            if (isPPE) {
                try {
                    await Actor.charge({ eventName: 'transcript-extracted', count: 1 });
                } catch {}
            }
        },
        async failedRequestHandler({ request }, error) {
            log.error(`Failed: ${request.userData.videoId} - ${error.message}`);
            stats.errors++;
        },
    });

    await mainCrawler.run(videoRequests);

    // Summary
    await Actor.setValue('RUN_SUMMARY', {
        ...stats,
        totalVideos: allVideoIds.length,
        completedAt: new Date().toISOString(),
    });

    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    log.info('  RUN COMPLETE');
    log.info(`  Transcripts extracted: ${stats.transcripts}`);
    log.info(`  No transcript available: ${stats.noTranscript}`);
    log.info(`  Errors: ${stats.errors}`);
    log.info(`  Total videos processed: ${allVideoIds.length}`);
    log.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

} catch (error) {
    log.error(`Actor failed: ${error.message}`);
    log.error(error.stack);
} finally {
    await Actor.exit();
}

/**
 * Extract cookies from HttpCrawler response for forwarding to InnerTube.
 */
function extractCookiesFromResponse(response) {
    try {
        if (!response) return '';
        const headers = response.headers || {};
        const setCookies = headers['set-cookie'];
        if (!setCookies) return '';
        const cookies = Array.isArray(setCookies) ? setCookies : [setCookies];
        return cookies
            .map(c => c.split(';')[0])
            .join('; ');
    } catch {
        return '';
    }
}

/**
 * Try multiple InnerTube client types to get player data with caption tracks.
 * Sends page cookies for authentication (needed for music videos / VEVO).
 */
async function fetchInnertubePlayer(videoId, proxyConfig, cookies = '', apiKey = INNERTUBE_API_KEY) {
    const clients = [
        {
            name: 'ANDROID',
            context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38' } },
            userAgent: 'com.google.android.youtube/20.10.38',
        },
        {
            name: 'IOS',
            context: { client: { clientName: 'IOS', clientVersion: '20.10.4' } },
            userAgent: 'com.google.ios.youtube/20.10.4',
        },
        {
            name: 'TVHTML5_EMBEDDED',
            context: { client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' }, thirdParty: { embedUrl: 'https://www.youtube.com/' } },
            userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.5) AppleWebKit/537.36 (KHTML, like Gecko) 85.0.4183.93/6.5 TV Safari/537.36',
        },
    ];

    let lastData = null;

    for (const client of clients) {
        try {
            const proxyUrl = proxyConfig ? await proxyConfig.newUrl() : undefined;
            const headers = {
                'Content-Type': 'application/json',
                'User-Agent': client.userAgent,
            };
            // Always send consent cookies + any page cookies
            const consentCookies = 'CONSENT=YES+cb.20210101-01-p0.en+FX+999; SOCS=CAISEwgDEgk2NTcyMzQwOTQaAmVuIAEaBgiA_LyaBg';
            headers['Cookie'] = cookies ? `${consentCookies}; ${cookies}` : consentCookies;

            const gotOptions = {
                url: `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
                method: 'POST',
                headers,
                body: JSON.stringify({
                    context: client.context,
                    videoId,
                }),
                responseType: 'text',
                timeout: { request: 15000 },
            };
            if (proxyUrl) gotOptions.proxyUrl = proxyUrl;
            const resp = await gotScraping(gotOptions);
            const data = JSON.parse(resp.body || '{}');
            const status = data?.playabilityStatus?.status;
            const hasCaptions = !!data?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length;

            log.info(`InnerTube ${client.name} for ${videoId}: ${status}, captions: ${hasCaptions}`);

            if (status === 'OK' && hasCaptions) return data;
            if (status === 'OK') lastData = data;
        } catch (err) {
            log.warning(`InnerTube ${client.name} failed for ${videoId}: ${err.message}`);
        }
    }

    // Return last OK response (might have no captions), or throw
    if (lastData) return lastData;
    throw new Error(`All InnerTube clients failed for ${videoId}`);
}

function extractMetadata(playerData, html) {
    const videoDetails = playerData?.videoDetails || {};
    const microformat = playerData?.microformat?.playerMicroformatRenderer || {};

    return {
        title: videoDetails.title || '',
        channelName: videoDetails.author || '',
        channelId: videoDetails.channelId || '',
        description: (videoDetails.shortDescription || '').substring(0, 2000),
        lengthSeconds: parseInt(videoDetails.lengthSeconds) || 0,
        viewCount: parseInt(videoDetails.viewCount) || 0,
        publishDate: microformat.publishDate || '',
        category: microformat.category || '',
        isLive: videoDetails.isLiveContent || false,
        keywords: (videoDetails.keywords || []).slice(0, 30),
        thumbnail: videoDetails.thumbnail?.thumbnails?.pop()?.url || '',
    };
}
