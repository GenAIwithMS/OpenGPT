<div align="center">

# ✦ OpenGPT ✦

### An open-source, ChatGPT-style AI assistant powered by LangGraph

Agentic tool use · Deep Research · Document Q&A (RAG) · Persistent multi-thread chats

<br />

<p>
  <img src="https://img.shields.io/badge/Python-3.13-3776AB?style=for-the-badge&logo=python&logoColor=white" alt="Python 3.13" />
  <img src="https://img.shields.io/badge/FastAPI-009688?style=for-the-badge&logo=fastapi&logoColor=white" alt="FastAPI" />
  <img src="https://img.shields.io/badge/LangGraph-1C3C3C?style=for-the-badge&logo=langchain&logoColor=white" alt="LangGraph" />
  <img src="https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 18" />
  <img src="https://img.shields.io/badge/Vite-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite" />
  <img src="https://img.shields.io/badge/Tailwind_CSS-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS" />
  <img src="https://img.shields.io/badge/MySQL-4479A1?style=for-the-badge&logo=mysql&logoColor=white" alt="MySQL" />
</p>

<p>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=22c55e" alt="License" /></a>
  <a href="https://github.com/GenAIwithMS/LangGraph-Chatbot/stargazers"><img src="https://img.shields.io/github/stars/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=facc15" alt="Stars" /></a>
  <a href="https://github.com/GenAIwithMS/LangGraph-Chatbot/network/members"><img src="https://img.shields.io/github/forks/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=60a5fa" alt="Forks" /></a>
  <a href="https://github.com/GenAIwithMS/LangGraph-Chatbot/issues"><img src="https://img.shields.io/github/issues/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=f97316" alt="Issues" /></a>
  <img src="https://img.shields.io/github/last-commit/GenAIwithMS/LangGraph-Chatbot?style=flat-square&color=a78bfa" alt="Last commit" />
</p>

<p>
  <a href="#quick-start"><b>Quick Start</b></a> ·
  <a href="#features"><b>Features</b></a> ·
  <a href="#technology-stack"><b>Tech Stack</b></a> ·
  <a href="#api-endpoints"><b>API</b></a> ·
  <a href="#contributing"><b>Contributing</b></a>
</p>

<br />

<img src="OpenGPT.png" alt="OpenGPT chat interface" width="92%" />

</div>

<br />

<table>
  <tr>
    <td align="center" width="25%">🧠<br /><b>Agentic by design</b><br /><sub>LangGraph orchestrates search, weather, stocks &amp; calculator tools</sub></td>
    <td align="center" width="25%">🔬<br /><b>Deep Research</b><br /><sub>Multi-step research that clarifies, plans, and writes a full report</sub></td>
    <td align="center" width="25%">📄<br /><b>Chat with documents</b><br /><sub>Upload files and ask questions with FAISS-backed RAG</sub></td>
    <td align="center" width="25%">💾<br /><b>Never lose a thread</b><br /><sub>MySQL-persisted conversations, plus temporary session-only chats</sub></td>
  </tr>
</table>

## About

OpenGPT is an AI chatbot built with LangGraph & RAG, featuring a FastAPI backend and React frontend with RAG capabilities, multi-threaded conversations, temporary (session-only) chats, and persistent MySQL storage.

## Features

- **FastAPI Backend**: Modern REST API with automatic documentation
- **React Frontend**: ChatGPT-inspired UI with Tailwind CSS
- **Multi-threaded Conversations**: Support for multiple chat threads with unique identifiers
- **RAG (Retrieval Augmented Generation)**: PDF upload and document Q&A
- **Persistent Storage**: MySQL database for storing conversation history and checkpoints
- **Tool Integration**: Multiple tools for enhanced functionality:
  - Web Search (Brave API)
  - Weather Information (OpenWeather API)
  - Calculator
  - Stock Price Lookup (Alpha Vantage API)

## Technology Stack

### Backend
- **Framework**: FastAPI + LangGraph
- **Model**: OpenAI GPT (via CanopyWave API)
- **Database**: MySQL with custom checkpoint saver
- **RAG**: FAISS + HuggingFace Embeddings
- **Language**: Python 3.x

### Frontend
- **Framework**: React 18 + Vite
- **Styling**: Tailwind CSS
- **HTTP Client**: Axios
- **Markdown**: React Markdown with GitHub Flavored Markdown
- **Icons**: Lucide React

## Prerequisites

- Python 3.8+
- Node.js 18+ and npm
- MySQL 5.7+ or MySQL 8.0+
- API Keys (configured in `.env` file):
  - OPENAI_API_KEY
  - BRAVE_API_KEY (for search)
  - OPENWEATHER_API_KEY (for weather)
  - ALPHA_VANTAGE_API_KEY (for stocks)
  - LANGSMITH_API_KEY (optional, for tracing)

## Quick Start

### Step 1: Database Setup

1. Make sure MySQL is installed and running
2. Copy and configure environment variables:
```bash
cd backend
cp .env.example .env
```

3. Edit `.env` with your MySQL credentials:
```env
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=chatbot_db
```

4. Initialize the database:
```bash
python -m database.init_db
```

See [database/README.md](database/README.md) for detailed database setup instructions.

### Step 2: Start Application

**Option 1: Use Start Script**

- **Windows:** double-click `start.bat` (or run `start.bat` from a terminal).
- **Linux / macOS:** run `./start.sh`. Make it executable first with `chmod +x start.sh` if needed.

These scripts start both the backend (port 8000) and the frontend (port 3000) automatically. The backend uses the project's `.venv` if present; the frontend installs dependencies via `npm install` on first run.

**Option 2: Manual Start**

**1. Start Backend:**
```bash
cd backend
python main.py
```

**2. Start Frontend:**
```bash
cd frontend
npm install  # First time only
npm run dev
```

**Access the application:**
- Frontend: http://localhost:3000
- Backend API: http://localhost:8000
- API Documentation: http://localhost:8000/docs

## Configuration

Edit your `.env` file with the required API keys:

```env
# OpenAI API Configuration
OPENAI_API_KEY=your_openai_api_key

# Tool API Keys
BRAVE_API_KEY=your_brave_api_key
OPENWEATHER_API_KEY=your_openweather_api_key
ALPHA_VANTAGE_API_KEY=your_alpha_vantage_api_key

# MySQL Database
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_mysql_password
MYSQL_DATABASE=chatbot_db

# Optional: LangSmith tracing
LANGCHAIN_TRACING_V2=false
LANGCHAIN_API_KEY=your_langsmith_key
```

## Project Structure

```
.
├── backend/                 # FastAPI application
│   ├── app/                 # Application package
│   │   ├── main.py          # FastAPI app initialization
│   │   ├── router/          # API route handlers
│   │   │   └── chat.py      # Chat, threads, RAG endpoints
│   │   ├── schema/          # Pydantic models
│   │   │   └── models.py    # Request/response schemas
│   │   ├── services/        # Business logic
│   │   │   ├── chatbot.py   # OpenGPT chatbot graph
│   │   │   ├── chat.py      # Chat operations
│   │   │   ├── rag.py       # RAG/document processing
│   │   │   └── thread.py    # Thread management
│   │   ├── database/        # Database configuration
│   │   │   ├── init_db.py   # Database initialization
│   │   │   ├── config.py    # Database config
│   │   │   └── mysql_checkpoint.py # Custom MySQL checkpointer
│   │   └── tools/           # External API tools
│   │       └── (search, weather, calc, stocks, blogs)
│   ├── main.py              # Backend entry point
│   └── requirements.txt     # Python dependencies
├── frontend/                # React frontend
│   ├── src/
│   │   ├── components/      # React components
│   │   ├── hooks/           # Custom hooks
│   │   ├── services/        # API client
│   │   └── App.jsx          # Main app
│   ├── package.json
│   └── vite.config.js
├── start.bat               # Windows startup script
└── start.sh                # Linux/Mac startup script
```

## API Endpoints

### Chat
- `POST /api/chat` - Send a message and get response
- `POST /api/chat/stream` - Stream response using Server-Sent Events

### Threads
- `GET /api/threads` - Get all conversation threads
- `POST /api/threads/new` - Create a new thread
- `GET /api/threads/{id}` - Get messages from a thread
- `PUT /api/threads/{id}/title` - Update thread title

### RAG/Documents
- `POST /api/upload-pdf` - Upload a PDF document
- `POST /api/query-document` - Query the uploaded document
- `GET /api/threads/{id}/document` - Get document information

## Features in Detail

### Chat Interface
- **Real-time Messaging**: Instant message delivery with loading states
- **Markdown Support**: Rich text formatting in responses
- **Code Highlighting**: Syntax highlighting for code blocks
- **Auto-scroll**: Automatically scrolls to latest messages

### Thread Management
- **Multiple Conversations**: Create and manage multiple chat threads
- **Thread Titles**: Auto-generated or custom thread titles
- **Conversation History**: All messages persisted in SQLite
- **Quick Switching**: Easy navigation between threads

### RAG (Document Q&A)
- **PDF Upload**: Drag & drop or click to upload PDF files
- **Document Chunking**: Automatic text splitting for better retrieval
- **Vector Search**: FAISS-based similarity search
- **Context-Aware**: Answers based on uploaded documents

### Tool Integration
- **Web Search**: Brave Search API for real-time information
- **Weather**: Current weather data from OpenWeather API
- **Calculator**: Built-in math expression evaluation
- **Stock Prices**: Real-time stock data from Alpha Vantage

## Development

### Backend Development
```bash
cd backend

# Install dependencies
pip install -r requirements.txt

# Run in development mode
python main.py

# API docs available at http://localhost:8000/docs
```

### Frontend Development
```bash
cd frontend

# Install dependencies
npm install

# Start dev server with hot reload
npm run dev

# Build for production
npm run build
```

## Troubleshooting

### Backend Issues
- **Import Errors**: Ensure all dependencies are installed with `pip install -r requirements.txt`
- **API Key Errors**: Check `.env` file has all required API keys
- **Database Errors**: Delete `chatbot.db` and restart to reset database

### Frontend Issues
- **CORS Errors**: Backend must allow `http://localhost:3000` origin
- **Connection Refused**: Ensure backend is running on port 8000
- **Build Errors**: Delete `node_modules` and run `npm install` again

### Common Solutions
1. Check that all API keys are valid in `.env`
2. Ensure ports 3000 and 8000 are not in use
3. Verify Python 3.8+ and Node.js 18+ are installed
4. Check firewall settings if connection issues persist

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- LangGraph team for the agentic framework
- Groq for fast LLM inference
- FastAPI for the modern Python web framework
- React and Vite for the frontend tooling
