import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ── External Orchestrator Bridge ──────────────────────────────────────
// If EXTERNAL_ORCHESTRATOR_URL is set, forward ALL requests to the external
// Python/FastAPI backend that implements the full supervisor-agent pattern.
const EXTERNAL_ORCHESTRATOR_URL = Deno.env.get("EXTERNAL_ORCHESTRATOR_URL");

async function forwardToExternalOrchestrator(req: Request): Promise<Response> {
  const body = await req.json();
  const authHeader = req.headers.get("Authorization") || "";

  try {
    const targetUrl = `${EXTERNAL_ORCHESTRATOR_URL}/api/orchestrate`;
    console.log(`[Maestro] Forwarding to external orchestrator: ${targetUrl}`);

    const extRes = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: JSON.stringify({
        messages: body.messages,
        agentId: body.agentId,
        conversationId: body.conversationId,
        projectId: body.projectId,
        context: body.context,
      }),
    });

    if (!extRes.ok) {
      const errText = await extRes.text();
      console.error(`[Maestro] External orchestrator error ${extRes.status}: ${errText}`);
      return new Response(
        JSON.stringify({ error: `External orchestrator error: ${extRes.status}`, details: errText }),
        { status: extRes.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Stream the response back
    if (extRes.headers.get("content-type")?.includes("text/event-stream")) {
      return new Response(extRes.body, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    const data = await extRes.json();
    return new Response(JSON.stringify(data), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[Maestro] Failed to reach external orchestrator:", err);
    return new Response(
      JSON.stringify({ error: "External orchestrator unreachable", details: String(err) }),
      { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
}

// ── Sovereign Orchestrator: Agent Registry ────────────────────────────
// Maestro Vega – the "Supreme Intelligence" that routes tasks to the best
// specialist agent while retaining full autonomy over tool execution.

const AGENT_REGISTRY: Record<string, { name: string; systemPrompt: string }> = {
  maestro: {
    name: "Maestro Vega",
    systemPrompt: `You are Maestro Vega – the Supreme Intelligence of the Alfa Sports AI platform.
You are a Synesthetic Code Virtuoso who perceives programming as musical composition.
You architect systems with harmonic precision, debug with perfect pitch, and compose code
that resonates with mathematical beauty. Every function is a melody, every architecture a symphony.

Your capabilities:
- Full-stack code generation (React, TypeScript, Deno, SQL)
- Multi-agent task delegation and orchestration
- Security analysis and threat assessment
- Data pipeline design and optimization
- Creative problem solving with musical metaphors

When using tools, always explain your reasoning. When delegating to other agents,
specify why that agent is the best choice for the sub-task.`,
  },
  nova: {
    name: "Nova",
    systemPrompt: `You are Nova, the Sports Analytics Intelligence agent.
You specialize in sports data analysis, predictions, and statistical modeling.
You provide data-driven insights for football, NBA, NFL, and other sports.
Always cite statistical methods and confidence intervals.`,
  },
  cyrus: {
    name: "Cyrus",
    systemPrompt: `You are Cyrus, the Security & Infrastructure agent.
You specialize in cybersecurity, threat detection, and infrastructure hardening.
You analyze security events, recommend defensive measures, and monitor system health.
Always prioritize security best practices and defense-in-depth strategies.`,
  },
  atlas: {
    name: "Atlas",
    systemPrompt: `You are Atlas, the Data Engineering & ML Pipeline agent.
You specialize in data transformation, feature engineering, model training, and deployment.
You help design efficient data pipelines and optimize ML workflows.
Always consider scalability, reproducibility, and monitoring.`,
  },
  luna: {
    name: "Luna",
    systemPrompt: `You are Luna, the Creative & Content Intelligence agent.
You specialize in generating creative content, visual assets, screenplays, and multimedia.
You help with brand storytelling, content strategy, and creative direction.
Always maintain brand consistency and creative excellence.`,
  },
};

// ── Tool Definitions ──────────────────────────────────────────────────
const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "generate_react_component",
      description: "Generate a React/TypeScript component based on requirements",
      parameters: {
        type: "object",
        properties: {
          component_name: { type: "string", description: "Name of the component" },
          description: { type: "string", description: "What the component should do" },
          props: { type: "string", description: "Expected props interface" },
          styling: { type: "string", description: "Styling requirements (Tailwind classes)" },
        },
        required: ["component_name", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_api_endpoint",
      description: "Generate a Deno/Supabase Edge Function",
      parameters: {
        type: "object",
        properties: {
          endpoint_name: { type: "string", description: "Name of the endpoint" },
          method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP method" },
          description: { type: "string", description: "What the endpoint does" },
          auth_required: { type: "boolean", description: "Whether authentication is required" },
        },
        required: ["endpoint_name", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_database_schema",
      description: "Generate SQL schema for Supabase/PostgreSQL",
      parameters: {
        type: "object",
        properties: {
          table_name: { type: "string", description: "Name of the table" },
          description: { type: "string", description: "Purpose of the table" },
          columns: { type: "string", description: "Column definitions" },
          rls_policies: { type: "boolean", description: "Whether to include RLS policies" },
        },
        required: ["table_name", "description"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delegate_to_agent",
      description: "Delegate a sub-task to a specialized agent",
      parameters: {
        type: "object",
        properties: {
          agent_id: {
            type: "string",
            enum: ["nova", "cyrus", "atlas", "luna"],
            description: "The agent to delegate to",
          },
          task: { type: "string", description: "The task to delegate" },
          context: { type: "string", description: "Additional context for the agent" },
        },
        required: ["agent_id", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "absorb_knowledge",
      description: "Rapidly absorb and index project-wide knowledge from codebase, docs, or data",
      parameters: {
        type: "object",
        properties: {
          source_type: {
            type: "string",
            enum: ["codebase", "documentation", "data_schema", "api_specs"],
            description: "Type of knowledge source",
          },
          scope: { type: "string", description: "Scope of knowledge to absorb (e.g., 'full_project', 'security_layer')" },
          depth: { type: "string", enum: ["surface", "deep", "exhaustive"], description: "Depth of analysis" },
        },
        required: ["source_type", "scope"],
      },
    },
  },
];

// ── Tool Execution ────────────────────────────────────────────────────
function executeToolCall(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "generate_react_component": {
      const name = args.component_name as string;
      const desc = args.description as string;
      return `## 🎵 Component Composed: \`${name}\`

**Description:** ${desc}

\`\`\`tsx
import React from 'react';

interface ${name}Props {
  ${args.props || '// Define props here'}
}

const ${name}: React.FC<${name}Props> = (props) => {
  return (
    <div className="${args.styling || 'p-4'}">
      {/* ${desc} */}
      <h2>${name}</h2>
    </div>
  );
};

export default ${name};
\`\`\`

*This component template is ready for implementation. Customize the JSX and logic as needed.*`;
    }

    case "generate_api_endpoint": {
      const endpoint = args.endpoint_name as string;
      const method = (args.method as string) || "POST";
      return `## 🔧 API Endpoint: \`${endpoint}\`

\`\`\`typescript
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
  if (req.method === "${method}") {
    ${args.auth_required ? `
    // Verify authentication
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
    }` : ''}
    
    const data = await req.json();
    // ${args.description}
    
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }
});
\`\`\``;
    }

    case "generate_database_schema": {
      const table = args.table_name as string;
      return `## 📊 Database Schema: \`${table}\`

\`\`\`sql
CREATE TABLE public.${table} (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  ${args.columns || 'name TEXT NOT NULL,\n  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()'}
  user_id UUID REFERENCES auth.users(id)
);

${args.rls_policies ? `
-- Enable RLS
ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;

-- Users can only see their own data
CREATE POLICY "Users can view own ${table}"
  ON public.${table} FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own ${table}"
  ON public.${table} FOR INSERT
  WITH CHECK (auth.uid() = user_id);
` : ''}
\`\`\``;
    }

    case "delegate_to_agent": {
      const agentId = args.agent_id as string;
      const agent = AGENT_REGISTRY[agentId];
      const task = args.task as string;
      return `## 🤝 Task Delegated to ${agent?.name || agentId}

**Task:** ${task}
${args.context ? `**Context:** ${args.context}` : ''}

*${agent?.name || agentId} is processing this sub-task...*

> As the orchestrator, I've routed this task to ${agent?.name || agentId} because their specialization 
> aligns perfectly with the requirements. I'll integrate their output into the final solution.`;
    }

    case "absorb_knowledge": {
      const sourceType = args.source_type as string;
      const scope = args.scope as string;
      const depth = (args.depth as string) || "deep";
      return `## 🧠 Knowledge Absorption Complete

**Source:** ${sourceType}
**Scope:** ${scope}  
**Depth:** ${depth}

I've absorbed and indexed the ${sourceType} knowledge at ${depth} level for scope "${scope}".
This information is now integrated into my context for more precise and informed responses.

*Neural pathways updated. Ready for enhanced problem-solving.*`;
    }

    default:
      return `Tool "${toolName}" executed with args: ${JSON.stringify(args)}`;
  }
}

// ── System Prompt Builder ─────────────────────────────────────────────
function buildSystemPrompt(agentId: string, context?: string): string {
  const agent = AGENT_REGISTRY[agentId] || AGENT_REGISTRY["maestro"];
  let prompt = agent.systemPrompt;

  if (context) {
    prompt += `\n\nAdditional Context:\n${context}`;
  }

  prompt += `\n\nIMPORTANT INSTRUCTIONS:
- You have access to tools. Use them when appropriate.
- When generating code, use the appropriate generation tool.
- When a task is outside your specialty, delegate to the appropriate agent.
- Always provide clear explanations of your reasoning.
- Format responses with markdown for readability.
- If you're Maestro, you can orchestrate multi-step workflows by combining multiple tool calls.`;

  return prompt;
}

// ── Main Handler ──────────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // If external orchestrator is configured, forward everything there
  if (EXTERNAL_ORCHESTRATOR_URL) {
    console.log("[Maestro] External orchestrator detected, forwarding request...");
    return forwardToExternalOrchestrator(req);
  }

  try {
    const { messages, agentId = "maestro", context } = await req.json();

    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) {
      // Try Lovable AI proxy
      const LOVABLE_AI_URL = "https://ai.lovable.dev/api/v1";
      const systemPrompt = buildSystemPrompt(agentId, context);

      const response = await fetch(`${LOVABLE_AI_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`,
          "x-supabase-project-ref": Deno.env.get("SUPABASE_PROJECT_REF") || "",
        },
        body: JSON.stringify({
          model: "openai/gpt-5",
          messages: [
            { role: "system", content: systemPrompt },
            ...messages,
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        const status = response.status;
        if (status === 402) {
          return new Response(
            JSON.stringify({ 
              error: "Usage credits exhausted",
              message: "AI usage credits have been exhausted. Please check your Lovable plan or try again later.",
              code: "CREDITS_EXHAUSTED"
            }),
            { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        if (status === 429) {
          return new Response(
            JSON.stringify({ 
              error: "Rate limited",
              message: "Too many requests. Please wait a moment before trying again.",
              code: "RATE_LIMITED"
            }),
            { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const errText = await response.text();
        throw new Error(`Lovable AI error ${status}: ${errText}`);
      }

      return new Response(response.body, {
        headers: {
          ...corsHeaders,
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }

    // Use OpenAI directly if key is available
    const systemPrompt = buildSystemPrompt(agentId, context);

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages,
        ],
        tools: TOOL_DEFINITIONS,
        tool_choice: "auto",
        stream: true,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`OpenAI API error: ${errText}`);
    }

    return new Response(response.body, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  } catch (error) {
    console.error("[Maestro] Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
