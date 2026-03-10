"""
YouTube Transcript Extractor — RAG Pipeline Example

Extract transcripts and feed them into a vector database for RAG.
Get your API token at: https://console.apify.com/settings/integrations

pip install apify-client langchain chromadb openai
"""
from apify_client import ApifyClient

client = ApifyClient("YOUR_API_TOKEN")

# Step 1: Extract transcripts from an entire playlist
run = client.actor("george.the.developer/youtube-transcript-scraper").call(run_input={
    "urls": ["https://www.youtube.com/playlist?list=YOUR_PLAYLIST_ID"],
    "language": "en",
    "outputFormat": "full-text",
    "includeMetadata": True,
    "maxVideos": 100,
})

# Step 2: Build documents for your vector store
documents = []
for video in client.dataset(run["defaultDatasetId"]).iterate_items():
    if video.get("hasTranscript"):
        documents.append({
            "text": video["transcriptText"],
            "metadata": {
                "source": video["videoUrl"],
                "title": video["title"],
                "channel": video["channelName"],
                "date": video.get("publishDate", ""),
            }
        })

print(f"Built {len(documents)} documents for RAG pipeline")
print(f"Total words: {sum(len(d['text'].split()) for d in documents):,}")

# Step 3: Chunk, embed, and index (using your preferred stack)
# from langchain.text_splitter import RecursiveCharacterTextSplitter
# splitter = RecursiveCharacterTextSplitter(chunk_size=1000, chunk_overlap=200)
# chunks = [splitter.split_text(doc["text"]) for doc in documents]
