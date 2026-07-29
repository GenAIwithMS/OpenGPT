from typing import Optional, List, Dict, Any
from datetime import datetime, date
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage, RemoveMessage
from app.services.chatbot import (
    chatbot,
    chatbot_memory,
    retrieve_all_threads,
    save_thread_title,
    get_thread_title_from_db,
    get_all_thread_metadata,
    touch_thread
)
from app.services.thread import generate_thread_id, generate_id_name
from app.services.rag import has_document

class ChatService:
    """Service class to handle chat-related business logic"""
    
    @staticmethod
    def create_new_thread() -> str:
        """Create a new thread and return its ID"""
        thread_id = generate_thread_id()
        save_thread_title(thread_id, "New Chat")
        return thread_id
    
    @staticmethod
    def get_or_create_thread_title(thread_id: str, user_message: Optional[str] = None) -> str:
        db_title = get_thread_title_from_db(thread_id)
        
        # If title is "New Chat" (default), generate a new one from the message
        if db_title and db_title != "New Chat":
            return db_title
        
        # Generate new title from user message
        if user_message:
            try:
                title = generate_id_name(user_message)
                save_thread_title(thread_id, title)
                return title
            except Exception as e:
                print(f"Error generating title: {e}")
                return str(thread_id)[:8] + "..."
        
        return str(thread_id)[:8] + "..."
    
    @staticmethod
    def get_all_threads() -> List[Dict[str, str]]:
        thread_ids = retrieve_all_threads()
        metadata = get_all_thread_metadata()
        
        threads = []
        for tid in thread_ids:
            thread_meta = metadata.get(tid, {})
            title = thread_meta.get("title", "New Chat") if isinstance(thread_meta, dict) else thread_meta
            updated_at = thread_meta.get("updated_at") if isinstance(thread_meta, dict) else None
            threads.append({
                "thread_id": tid,
                "title": title,
                "updated_at": updated_at
            })
        
        # Sort by updated_at descending (most recent first)
        threads.sort(key=lambda x: x.get("updated_at") or datetime.min, reverse=True)
        
        return threads
    
    @staticmethod
    def load_conversation(thread_id: str) -> List[Dict[str, str]]:
        try:
            state = chatbot.get_state(config={"configurable": {"thread_id": thread_id}})
            messages = state.values.get("messages", [])
            
            formatted_messages = []
            for message in messages:
                if isinstance(message, HumanMessage):
                    formatted_messages.append({
                        "content": message.content,
                        "type": "human"
                    })
                elif isinstance(message, AIMessage):
                    if message.content:
                        formatted_messages.append({
                            "content": message.content,
                            "type": "ai"
                        })
            
            return formatted_messages
        except Exception as e:
            print(f"Error loading conversation: {e}")
            return []
    
    @staticmethod
    def send_message(message: str, thread_id: str, tools: Optional[List[str]] = None) -> Dict[str, Any]:
        config = {
            "configurable": {"thread_id": thread_id},
            "metadata": {"thread_id": thread_id}
        }
        
        try:
            # If blogs tool is requested, use the blog app
            if tools and "blogs" in tools:
                try:
                    from app.tools.blogs.graph import app as blog_app
                    
                    blog_state = {
                        "topic": message,
                        "as_of": date.today().isoformat(),
                    }
                    
                    final_state = blog_app.invoke(blog_state)
                    
                    # Update thread timestamp
                    touch_thread(thread_id)
                    
                    return {
                        "response": final_state.get("final", "Blog generated successfully"),
                        "thread_id": thread_id,
                        "tool_used": "blogs"
                    }
                except Exception as blog_error:
                    error_msg = str(blog_error)
                    print(f"Error using blog tool: {error_msg}")
                    
                    # Provide user-friendly error messages
                    if "name resolution failed" in error_msg or "503" in error_msg:
                        return {
                            "response": "⚠️ **Blog Generation Failed**\n\nThe blog generation service is currently unavailable (network connection issue). This could be due to:\n- External API service is down\n- Network connectivity issues\n- DNS resolution problems\n\nPlease try again later or use the regular chat without the blog tool.",
                            "thread_id": thread_id,
                            "tool_used": "blogs"
                        }
                    else:
                        return {
                            "response": f"⚠️ **Blog Generation Failed**\n\nAn error occurred while generating the blog:\n```\n{error_msg}\n```\n\nPlease try again or use the regular chat without the blog tool.",
                            "thread_id": thread_id,
                            "tool_used": "blogs"
                        }
            
            # If deep_research tool is requested, use the deep research graph
            if tools and "deep_research" in tools:
                try:
                    from app.tools.deep_research.deep_researcher import deep_researcher as deep_research_app

                    deep_input = {
                        "messages": [HumanMessage(content=message)]
                    }

                    deep_config = {
                        "configurable": {"allow_clarification": False}
                    }

                    final_state = deep_research_app.invoke(deep_input, deep_config)

                    touch_thread(thread_id)

                    return {
                        "response": final_state.get("final_report", "Deep research completed successfully"),
                        "thread_id": thread_id,
                        "tool_used": "deep_research"
                    }
                except Exception as deep_error:
                    error_msg = str(deep_error)
                    print(f"Error using deep research tool: {error_msg}")
                    return {
                        "response": f"⚠️ **Deep Research Failed**\n\nAn error occurred:\n```\n{error_msg}\n```",
                        "thread_id": thread_id,
                        "tool_used": "deep_research"
                    }

            # Check if thread has a document
            doc_exists = has_document(thread_id)
            
            # Invoke chatbot with user message
            final_state = chatbot.invoke(
                {
                    "messages": [HumanMessage(content=message)],
                    "has_document": doc_exists,
                    "thread_id": thread_id
                },
                config=config
            )
            
            messages = final_state["messages"]
            
            # Update thread timestamp to show recent activity
            touch_thread(thread_id)
            
            # Extract the last AI message
            ai_response = None
            has_tool_calls = False
            
            for msg in reversed(messages):
                if isinstance(msg, ToolMessage):
                    has_tool_calls = True
                if isinstance(msg, AIMessage) and not ai_response:
                    ai_response = msg.content
                    break
            
            return {
                "response": ai_response or "No response generated",
                "thread_id": thread_id,
                "has_tool_calls": has_tool_calls
            }
        except Exception as e:
            print(f"Error sending message: {e}")
            raise Exception(f"Failed to send message: {str(e)}")

    @staticmethod
    def regenerate_message(thread_id: str, tools: Optional[List[str]] = None) -> Dict[str, Any]:
        """Regenerate the last AI response without appending a new human message.

        This re-runs the agent from the current thread state so the prior user
        prompt is reused as context instead of being sent again.
        """
        config = {
            "configurable": {"thread_id": thread_id},
            "metadata": {"thread_id": thread_id},
        }

        try:
            # Blogs tool uses a separate, stateless graph keyed by topic
            if tools and "blogs" in tools:
                try:
                    from app.tools.blogs.graph import app as blog_app

                    blog_state_obj = blog_app.get_state(config)
                    topic = (
                        blog_state_obj.values.get("topic")
                        if blog_state_obj and blog_state_obj.values
                        else None
                    )
                    if not topic:
                        raise Exception("No blog topic found to regenerate")

                    final_state = blog_app.invoke(
                        {"topic": topic, "as_of": date.today().isoformat()}
                    )
                    touch_thread(thread_id)
                    return {
                        "response": final_state.get("final", "Blog generated successfully"),
                        "thread_id": thread_id,
                        "tool_used": "blogs",
                    }
                except Exception as blog_error:
                    return {
                        "response": f"⚠️ **Blog Generation Failed**\n\n{str(blog_error)}",
                        "thread_id": thread_id,
                        "tool_used": "blogs",
                    }

            # Chatbot path: drop the trailing assistant turn, then re-run
            current = chatbot.get_state(config)
            messages = list(current.values["messages"]) if current and current.values else []

            last_ai_idx = None
            for i in reversed(range(len(messages))):
                if isinstance(messages[i], AIMessage):
                    last_ai_idx = i
                    break

            if last_ai_idx is None:
                raise Exception("No AI response found to regenerate")

            # Remove the assistant turn (and any tool results that follow it)
            removals = [
                RemoveMessage(id=m.id)
                for m in messages[last_ai_idx:]
                if getattr(m, "id", None)
            ]
            if removals:
                chatbot.update_state(current.config, {"messages": removals})

            doc_exists = has_document(thread_id)

            final_state = chatbot.invoke(
                {
                    "messages": [],
                    "has_document": doc_exists,
                    "thread_id": thread_id,
                },
                config=config,
            )

            out_messages = final_state["messages"]
            touch_thread(thread_id)

            ai_response = None
            has_tool_calls = False
            for msg in reversed(out_messages):
                if isinstance(msg, ToolMessage):
                    has_tool_calls = True
                if isinstance(msg, AIMessage) and not ai_response:
                    ai_response = msg.content
                    break

            return {
                "response": ai_response or "No response generated",
                "thread_id": thread_id,
                "has_tool_calls": has_tool_calls,
            }
        except Exception as e:
            print(f"Error regenerating message: {e}")
            raise Exception(f"Failed to regenerate message: {str(e)}")

    @staticmethod
    def _stream_chatbot(graph, config, doc_exists: bool, human_message, temporary: bool = False):
        """Yield live-thinking/ai chunks while running the chatbot graph.

        When ``human_message`` is provided it is sent as a new turn; when it is
        ``None`` the graph continues from the current checkpoint (used for
        edit/regenerate so no duplicate user message is appended).

        ``graph`` is the compiled chatbot (``chatbot`` for persisted chats or
        ``chatbot_memory`` for temporary, session-only chats). When ``temporary``
        is True nothing is persisted back to the database.
        """
        yield {"content": "Thinking...", "message_type": "thinking"}

        seen_tool_calls = set()
        input_messages = (
            [HumanMessage(content=human_message)] if human_message is not None else []
        )

        # Streamed text can arrive either in ``content`` (the final answer) or,
        # for reasoning models like gpt-oss, in ``additional_kwargs.reasoning_content``
        # (the chain-of-thought). Keep the answer in the response bubble and the
        # reasoning in the thinking bar so the saved response stays clean.
        answer_parts = []
        reasoning_parts = []

        for message_chunk, metadata in graph.stream(
            {
                "messages": input_messages,
                "has_document": doc_exists,
                "thread_id": config["configurable"]["thread_id"],
            },
            config=config,
            stream_mode="messages",
        ):
            # Tool produced a result -> live "finished" signal
            if isinstance(message_chunk, ToolMessage):
                name = getattr(message_chunk, "name", None) or "tool"
                yield {
                    "content": f"Finished using {name}.",
                    "message_type": "thinking",
                }
                continue

            if isinstance(message_chunk, AIMessage):
                # The assistant is invoking a tool -> live "using" signal
                for tc in getattr(message_chunk, "tool_calls", None) or []:
                    tc_id = tc.get("id")
                    name = tc.get("name", "tool")
                    if tc_id and tc_id not in seen_tool_calls:
                        seen_tool_calls.add(tc_id)
                        yield {
                            "content": f"Using {name}...",
                            "message_type": "thinking",
                        }

                content = message_chunk.content
                reasoning = message_chunk.additional_kwargs.get("reasoning_content", "")
                # The actual answer arrives in ``content`` -> response bubble.
                if isinstance(content, str) and content:
                    answer_parts.append(content)
                    yield {"content": content, "message_type": "ai"}
                # The model's chain-of-thought arrives in ``reasoning_content``
                # -> thinking bar (kept out of the saved response).
                if reasoning:
                    reasoning_parts.append(reasoning)
                    yield {"content": reasoning, "message_type": "thinking"}

        # Persist the full assistant response. langgraph's streamed-chunk merge
        # leaves the stored AIMessage empty for this model, so write it back
        # explicitly: drop the trailing (empty) assistant message and append one
        # with the real content. The answer lives in ``content``; only fall back
        # to reasoning when the model emitted no final answer. Temporary chats
        # are never persisted — they live only in the in-memory graph.
        if temporary:
            return
        persist_text = "".join(answer_parts).strip() or "".join(reasoning_parts).strip()
        if persist_text:
            try:
                current = chatbot.get_state(config=config)
                msgs = list(current.values.get("messages", []))
                if msgs and isinstance(msgs[-1], AIMessage):
                    chatbot.update_state(
                        config, {"messages": [RemoveMessage(id=msgs[-1].id)]}
                    )
                chatbot.update_state(
                    config, {"messages": [AIMessage(content=persist_text)]}
                )
            except Exception as e:
                print(f"Error persisting final assistant message: {e}")

    @staticmethod
    def stream_message(message: str, thread_id: str, tools: Optional[List[str]] = None, temporary: bool = False):
        # Temporary chats run on an in-memory checkpointer and never touch the
        # database. Use the memory-backed graph so nothing is persisted.
        graph = chatbot_memory if temporary else chatbot

        config = {
            "configurable": {"thread_id": thread_id},
            "metadata": {"thread_id": thread_id}
        }

        try:
            # If blogs tool is requested, stream the blog generation process
            if tools and "blogs" in tools:
                try:
                    from app.tools.blogs.graph import app as blog_app

                    blog_state = {
                        "topic": message,
                        "as_of": date.today().isoformat(),
                    }

                    for event in blog_app.stream(blog_state, stream_mode="updates"):
                        for node_name, node_output in event.items():
                            # Stream progress updates for different nodes
                            if node_name == "router":
                                yield {
                                    "content": f"✓ Routing complete - Mode: {node_output.get('mode', 'unknown')}",
                                    "message_type": "progress",
                                    "node": "router"
                                }
                            elif node_name == "research":
                                evidence_count = len(node_output.get('evidence', []))
                                yield {
                                    "content": f"✓ Research complete - Found {evidence_count} sources",
                                    "message_type": "progress",
                                    "node": "research"
                                }
                            elif node_name == "orchestrator":
                                plan = node_output.get('plan')
                                if plan:
                                    yield {
                                        "content": f"✓ Planning complete - {len(plan.tasks)} sections planned",
                                        "message_type": "progress",
                                        "node": "orchestrator"
                                    }
                            elif node_name == "worker":
                                yield {
                                    "content": "✓ Section written",
                                    "message_type": "progress",
                                    "node": "worker"
                                }
                            elif node_name == "reducer":
                                if 'final' in node_output:
                                    yield {
                                        "content": node_output['final'],
                                        "message_type": "ai",
                                        "node": "final"
                                    }

                    # Update thread timestamp
                    if not temporary:
                        touch_thread(thread_id)
                    return
                except Exception as blog_error:
                    error_msg = str(blog_error)
                    print(f"Error streaming blog tool: {error_msg}")

                    # Provide user-friendly error messages
                    if "name resolution failed" in error_msg or "503" in error_msg:
                        yield {
                            "content": "⚠️ **Blog Generation Failed**\n\nThe blog generation service is currently unavailable (network connection issue). This could be due to:\n- External API service is down\n- Network connectivity issues\n- DNS resolution problems\n\nPlease try again later or use the regular chat without the blog tool.",
                            "message_type": "ai"
                        }
                    else:
                        yield {
                            "content": f"⚠️ **Blog Generation Failed**\n\nAn error occurred while generating the blog:\n```\n{error_msg}\n```\n\nPlease try again or use the regular chat without the blog tool.",
                            "message_type": "ai"
                        }
                    return

            # If deep_research tool is requested, run the deep research graph
            if tools and "deep_research" in tools:
                try:
                    from app.tools.deep_research.deep_researcher import deep_researcher as deep_research_app

                    deep_input = {
                        "messages": [HumanMessage(content=message)]
                    }

                    deep_config = {
                        "configurable": {"allow_clarification": False}
                    }

                    for event in deep_research_app.stream(deep_input, deep_config, stream_mode="updates"):
                        for node_name, node_output in event.items():
                            if node_name == "clarify_with_user":
                                yield {"content": "Scope clarified", "message_type": "progress", "node": "clarify"}
                            elif node_name == "write_research_brief":
                                yield {"content": "Research brief written", "message_type": "progress", "node": "brief"}
                            elif node_name == "research_supervisor":
                                yield {"content": "Research complete", "message_type": "progress", "node": "research"}
                            elif node_name == "final_report_generation":
                                if "final_report" in node_output:
                                    yield {"content": node_output["final_report"], "message_type": "ai", "node": "report"}

                    if not temporary:
                        touch_thread(thread_id)
                    return
                except Exception as deep_error:
                    error_msg = str(deep_error)
                    print(f"Error streaming deep research: {error_msg}")
                    yield {
                        "content": f"⚠️ **Deep Research Failed**\n\nAn error occurred:\n```\n{error_msg}\n```",
                        "message_type": "ai"
                    }
                    return

            # Check if thread has a document (skipped for temp chats — they
            # cannot have uploaded PDFs and must not touch document storage).
            doc_exists = False if temporary else has_document(thread_id)

            # Stream tokens from the chatbot graph (live thinking + AI output)
            yield from ChatService._stream_chatbot(graph, config, doc_exists, message, temporary)
        except Exception as e:
            print(f"Error streaming message: {e}")
            raise Exception(f"Failed to stream message: {str(e)}")
    
    @staticmethod
    def edit_message_stream(thread_id: str, new_content: str, human_index: int, tools: Optional[List[str]] = None):
        """Edit a previously sent user message and regenerate the response.

        The targeted human turn is rewritten in-place, every message after it
        is dropped (mirroring how ChatGPT/Claude discard the conversation after
        an edited message), and the agent re-runs from that point.
        """
        config = {
            "configurable": {"thread_id": thread_id},
            "metadata": {"thread_id": thread_id},
        }

        try:
            doc_exists = has_document(thread_id)

            current = chatbot.get_state(config)
            messages = list(current.values["messages"]) if current and current.values else []

            human_indices = [i for i, m in enumerate(messages) if isinstance(m, HumanMessage)]
            if not human_indices or human_index < 0 or human_index >= len(human_indices):
                raise Exception("Invalid message index to edit")

            target_idx = human_indices[human_index]

            # Both the removals and the re-inserted (edited) human message must be
            # applied in a SINGLE update_state. Using two separate calls with the
            # same checkpoint config causes the second to overwrite the first,
            # dropping the removals and merely appending a duplicate human turn.
            edit_ops = [
                RemoveMessage(id=m.id)
                for m in messages[target_idx:]
                if getattr(m, "id", None)
            ]
            edit_ops.append(HumanMessage(content=new_content))
            chatbot.update_state(current.config, {"messages": edit_ops})

            # Blogs tool uses a separate, stateless graph keyed by topic
            if tools and "blogs" in tools:
                try:
                    from app.tools.blogs.graph import app as blog_app

                    blog_state = {
                        "topic": new_content,
                        "as_of": date.today().isoformat(),
                    }

                    for event in blog_app.stream(blog_state, stream_mode="updates"):
                        for node_name, node_output in event.items():
                            if node_name == "router":
                                yield {
                                    "content": f"✓ Routing complete - Mode: {node_output.get('mode', 'unknown')}",
                                    "message_type": "progress",
                                    "node": "router",
                                }
                            elif node_name == "research":
                                evidence_count = len(node_output.get('evidence', []))
                                yield {
                                    "content": f"✓ Research complete - Found {evidence_count} sources",
                                    "message_type": "progress",
                                    "node": "research",
                                }
                            elif node_name == "orchestrator":
                                plan = node_output.get('plan')
                                if plan:
                                    yield {
                                        "content": f"✓ Planning complete - {len(plan.tasks)} sections planned",
                                        "message_type": "progress",
                                        "node": "orchestrator",
                                    }
                            elif node_name == "worker":
                                yield {
                                    "content": "✓ Section written",
                                    "message_type": "progress",
                                    "node": "worker",
                                }
                            elif node_name == "reducer":
                                if 'final' in node_output:
                                    yield {
                                        "content": node_output['final'],
                                        "message_type": "ai",
                                        "node": "final",
                                    }

                    touch_thread(thread_id)
                    return
                except Exception as blog_error:
                    error_msg = str(blog_error)
                    print(f"Error editing blog tool: {error_msg}")
                    if "name resolution failed" in error_msg or "503" in error_msg:
                        yield {
                            "content": "⚠️ **Blog Generation Failed**\n\nThe blog generation service is currently unavailable (network connection issue). This could be due to:\n- External API service is down\n- Network connectivity issues\n- DNS resolution problems\n\nPlease try again later or use the regular chat without the blog tool.",
                            "message_type": "ai",
                        }
                    else:
                        yield {
                            "content": f"⚠️ **Blog Generation Failed**\n\nAn error occurred while generating the blog:\n```\n{error_msg}\n```\n\nPlease try again or use the regular chat without the blog tool.",
                            "message_type": "ai",
                        }
                    return

            # If deep_research tool is requested, run the deep research graph
            if tools and "deep_research" in tools:
                try:
                    from app.tools.deep_research.deep_researcher import deep_researcher as deep_research_app

                    deep_input = {
                        "messages": [HumanMessage(content=new_content)]
                    }

                    deep_config = {
                        "configurable": {"allow_clarification": False}
                    }

                    for event in deep_research_app.stream(deep_input, deep_config, stream_mode="updates"):
                        for node_name, node_output in event.items():
                            if node_name == "clarify_with_user":
                                yield {"content": "Scope clarified", "message_type": "progress", "node": "clarify"}
                            elif node_name == "write_research_brief":
                                yield {"content": "Research brief written", "message_type": "progress", "node": "brief"}
                            elif node_name == "research_supervisor":
                                yield {"content": "Research complete", "message_type": "progress", "node": "research"}
                            elif node_name == "final_report_generation":
                                if "final_report" in node_output:
                                    yield {"content": node_output["final_report"], "message_type": "ai", "node": "report"}

                    touch_thread(thread_id)
                    return
                except Exception as deep_error:
                    error_msg = str(deep_error)
                    print(f"Error editing deep research: {error_msg}")
                    yield {
                        "content": f"⚠️ **Deep Research Failed**\n\nAn error occurred:\n```\n{error_msg}\n```",
                        "message_type": "ai"
                    }
                    return

            yield from ChatService._stream_chatbot(chatbot, config, doc_exists, None)
            touch_thread(thread_id)
        except Exception as e:
            print(f"Error editing message: {e}")
            raise Exception(f"Failed to edit message: {str(e)}")

    @staticmethod
    def update_thread_title(thread_id: str, title: str) -> bool:
        """Update the title for a thread"""
        try:
            save_thread_title(thread_id, title)
            return True
        except Exception as e:
            print(f"Error updating title: {e}")
            return False
    
    @staticmethod
    def delete_thread(thread_id: str) -> bool:
        """Delete a thread and all its associated data"""
        from app.database import DatabaseConfig, ThreadMetadata, DocumentMetadata, Checkpoint, CheckpointWrite
        from app.services.rag import _thread_paths
        import os
        
        session = DatabaseConfig.get_session_factory()()
        try:
            # Delete from database tables (cascade will handle related records)
            
            # Delete checkpoints and checkpoint writes
            session.query(CheckpointWrite).filter_by(thread_id=thread_id).delete()
            session.query(Checkpoint).filter_by(thread_id=thread_id).delete()
            
            # Delete document metadata (this should cascade from thread_metadata but let's be explicit)
            session.query(DocumentMetadata).filter_by(thread_id=thread_id).delete()
            
            # Delete thread metadata
            session.query(ThreadMetadata).filter_by(thread_id=thread_id).delete()
            
            session.commit()
            
            # Clean up storage files (uploaded document + metadata JSON). The
            # document path lives in the thread's RAG metadata (extension may
            # vary: .pdf/.md/.txt), so read it from there.
            try:
                from app.services.rag import _read_metadata
                meta_path = os.path.join(
                    os.path.dirname(__file__), "..", "storage", "documents", f"{thread_id}.json"
                )
                meta = _read_metadata(thread_id) or {}
                doc_path = meta.get("file_path")
                if doc_path and os.path.exists(doc_path):
                    os.remove(doc_path)
                    print(f"Deleted document file: {doc_path}")
                if os.path.exists(meta_path):
                    os.remove(meta_path)
                    print(f"Deleted metadata file: {meta_path}")
            except Exception as e:
                print(f"Warning: Failed to delete storage files for thread {thread_id}: {e}")
                # Don't fail the whole operation if file cleanup fails
            
            # Clear any in-memory caches
            try:
                from app.services.rag import _THREAD_RETRIEVERS, _THREAD_METADATA
                if thread_id in _THREAD_RETRIEVERS:
                    del _THREAD_RETRIEVERS[thread_id]
                if thread_id in _THREAD_METADATA:
                    del _THREAD_METADATA[thread_id]
            except Exception as e:
                print(f"Warning: Failed to clear thread cache for {thread_id}: {e}")
            
            print(f"Successfully deleted thread: {thread_id}")
            return True
            
        except Exception as e:
            session.rollback()
            print(f"Error deleting thread {thread_id}: {e}")
            return False
        finally:
            session.close()
