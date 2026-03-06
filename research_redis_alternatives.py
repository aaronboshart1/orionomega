#!/usr/bin/env python3
"""
Research script to gather information about Redis alternatives
"""
import json
import subprocess
import requests
from datetime import datetime

# List of Redis alternatives to research
alternatives = [
    "Valkey",
    "Dragonfly", 
    "KeyDB",
    "Memcached",
    "Garnet",
    "Apache Ignite",
    "Hazelcast"
]

def get_github_info(repo_url):
    """Get GitHub repository information"""
    try:
        # Extract owner/repo from URL
        parts = repo_url.replace("https://github.com/", "").split("/")
        if len(parts) >= 2:
            owner, repo = parts[0], parts[1]
            api_url = f"https://api.github.com/repos/{owner}/{repo}"
            
            # Make request without authentication (rate limited but should work for basic info)
            response = requests.get(api_url, timeout=10)
            if response.status_code == 200:
                data = response.json()
                return {
                    "stars": data.get("stargazers_count", 0),
                    "forks": data.get("forks_count", 0),
                    "last_updated": data.get("updated_at", ""),
                    "description": data.get("description", ""),
                    "language": data.get("language", ""),
                    "open_issues": data.get("open_issues_count", 0)
                }
    except Exception as e:
        print(f"Error fetching GitHub info for {repo_url}: {e}")
    return None

# Research data for each alternative
research_data = {
    "Valkey": {
        "github": "https://github.com/valkey-io/valkey",
        "description": "A high-performance data structure server that originated as a fork of Redis",
        "key_features": ["Redis-compatible", "High performance", "Active development", "Linux Foundation project"],
        "production_adoption": "Growing adoption, backed by major cloud providers",
        "maintainership": "Linux Foundation project with active community"
    },
    
    "Dragonfly": {
        "github": "https://github.com/dragonflydb/dragonfly",
        "description": "A modern in-memory datastore, fully compatible with Redis and Memcached APIs",
        "key_features": ["Multi-threaded architecture", "Redis + Memcached compatible", "Better performance", "Lower memory usage"],
        "production_adoption": "Growing in production environments, especially for high-performance use cases",
        "maintainership": "Actively maintained by DragonflyDB team"
    },
    
    "KeyDB": {
        "github": "https://github.com/Snapchat/KeyDB",
        "description": "A high performance fork of Redis with a focus on multithreading, memory efficiency, and high throughput",
        "key_features": ["Multi-threaded", "Redis-compatible", "Better performance", "Active-replica support"],
        "production_adoption": "Used by Snapchat and other companies in production",
        "maintainership": "Maintained by Snapchat with community contributions"
    },
    
    "Memcached": {
        "github": "https://github.com/memcached/memcached",
        "description": "Distributed memory caching system for speeding up dynamic web applications",
        "key_features": ["Simple key-value store", "Distributed caching", "Mature and stable", "Low overhead"],
        "production_adoption": "Widely adopted in production, used by major web companies",
        "maintainership": "Long-standing project with stable maintenance"
    },
    
    "Garnet": {
        "github": "https://github.com/microsoft/garnet",
        "description": "A remote cache-store from Microsoft Research that offers strong performance and scalability",
        "key_features": ["High performance", "Redis-compatible", "Built on .NET", "RESP protocol support"],
        "production_adoption": "Microsoft-backed, growing adoption in .NET ecosystems",
        "maintainership": "Actively maintained by Microsoft Research"
    }
}

print("Researching Redis alternatives...")
print("=" * 50)

for name, data in research_data.items():
    print(f"\n{name}:")
    print(f"Description: {data['description']}")
    print(f"GitHub: {data['github']}")
    
    # Try to get GitHub stats
    github_info = get_github_info(data['github'])
    if github_info:
        print(f"Stars: {github_info['stars']:,}")
        print(f"Forks: {github_info['forks']:,}")
        print(f"Last updated: {github_info['last_updated']}")
        print(f"Open issues: {github_info['open_issues']:,}")
    
    print(f"Key features: {', '.join(data['key_features'])}")
    print(f"Production adoption: {data['production_adoption']}")
    print(f"Maintainership: {data['maintainership']}")

print("\n" + "=" * 50)
print("Research completed!")