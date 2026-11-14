import operator
from typing import TypedDict, List, Optional, Annotated

from langgraph.graph import StateGraph, START, END

from .schemas import Plan, EvidenceItem
from .router import router_node, route_next
from .research import research_node
from .orchestrator import orchestrator_node, fanout
from .worker import worker_node
from .reducer import build_reducer_subgraph


class State(TypedDict):
    topic: str

    # routing / research
    mode: str
    needs_research: bool
    queries: List[str]
    evidence: List[EvidenceItem]
    plan: Optional[Plan]

    # recency
    as_of: str
    recency_days: int

    # workers
    sections: Annotated[List[tuple[int, str]], operator.add]  # (task_id, section_md)

    # reducer/image
    merged_md: str
    md_with_placeholders: str
    image_specs: List[dict]

    final: str

    # False for temporary chats: nothing may be written to disk.
    persist: bool


def build_blog_graph():
    # Build reducer subgraph
    reducer_subgraph = build_reducer_subgraph(State)

    # Build main graph
    g = StateGraph(State)
    g.add_node("router", router_node)
    g.add_node("research", research_node)
    g.add_node("orchestrator", orchestrator_node)
    g.add_node("worker", worker_node)
    g.add_node("reducer", reducer_subgraph)

    g.add_edge(START, "router")
    g.add_conditional_edges("router", route_next, {"research": "research", "orchestrator": "orchestrator"})
    g.add_edge("research", "orchestrator")

    g.add_conditional_edges("orchestrator", fanout, ["worker"])
    g.add_edge("worker", "reducer")
    g.add_edge("reducer", END)

    return g.compile()


# Create the app instance
app = build_blog_graph()
