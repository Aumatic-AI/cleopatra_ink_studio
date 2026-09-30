export type Json = string | number | boolean | null | { [key: string]: Json } | Json[];

export interface Database {
  public: {
    Views: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
    Functions: {
      finalize_session: {
        Args: {
          p_session_id: string;
          p_design_id: string;
          p_placement_id: string;
        };
        Returns: void;
      };
      finalize_rework_session: {
        Args: {
          p_session_id: string;
          p_design_id: string;
        };
        Returns: void;
      };
    };
    Tables: {
      users: {
        Row: {
          id: string;
          first_name: string;
          phone: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          first_name: string;
          phone: string;
          created_at?: string;
        };
        Update: {
          first_name?: string;
        };
      };
      sessions: {
        Row: {
          id: string;
          user_id: string | null;
          tattoo_style: string | null;
          tattoo_description: string | null;
          flow_type: "ai_design" | "rework" | "direct";
          rework_source_photo_url: string | null;
          rework_mode: "cover" | "extend" | null;
          status: "active" | "completed" | "abandoned";
          created_at: string;
          completed_at: string | null;
          deleted_at: string | null;
        };
        Insert: {
          id: string;
          user_id?: string | null;
          tattoo_style?: string | null;
          tattoo_description?: string | null;
          flow_type?: "ai_design" | "rework" | "direct";
          rework_source_photo_url?: string | null;
          rework_mode?: "cover" | "extend" | null;
          status?: "active" | "completed" | "abandoned";
          created_at?: string;
          completed_at?: string | null;
          deleted_at?: string | null;
        };
        Update: {
          user_id?: string | null;
          tattoo_style?: string | null;
          tattoo_description?: string | null;
          flow_type?: "ai_design" | "rework" | "direct";
          rework_source_photo_url?: string | null;
          rework_mode?: "cover" | "extend" | null;
          status?: "active" | "completed" | "abandoned";
          completed_at?: string | null;
          deleted_at?: string | null;
        };
      };
      tattoo_designs: {
        Row: {
          id: string;
          session_id: string;
          image_url: string;
          style_name: string | null;
          pattern_type: string | null;
          iteration: number;
          is_finalized: boolean;
          parent_design_ids: string[];
          user_instruction: string | null;
          flash_image_url: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          image_url: string;
          style_name?: string | null;
          pattern_type?: string | null;
          iteration?: number;
          is_finalized?: boolean;
          parent_design_ids?: string[];
          user_instruction?: string | null;
          flash_image_url?: string | null;
          created_at?: string;
        };
        Update: {
          is_finalized?: boolean;
          flash_image_url?: string | null;
        };
      };
      chat_messages: {
        Row: {
          id: string;
          session_id: string;
          role: "user" | "assistant";
          content: string | null;
          image_urls: string[];
          design_ids: string[];
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          role: "user" | "assistant";
          content?: string | null;
          image_urls?: string[];
          design_ids?: string[];
          created_at?: string;
        };
        Update: {
          content?: string | null;
          image_urls?: string[];
          design_ids?: string[];
        };
      };
      placements: {
        Row: {
          id: string;
          session_id: string;
          placement_text: string | null;
          body_photo_url: string | null;
          final_composite_url: string | null;
          is_finalized: boolean;
          created_at: string;
        };
        Insert: {
          id?: string;
          session_id: string;
          placement_text?: string | null;
          body_photo_url?: string | null;
          final_composite_url?: string | null;
          is_finalized?: boolean;
          created_at?: string;
        };
        Update: {
          placement_text?: string | null;
          body_photo_url?: string | null;
          final_composite_url?: string | null;
          is_finalized?: boolean;
        };
      };
      user_preferences: {
        Row: {
          user_id: string;
          preferred_styles: string[];
          preferred_placements: string[];
          updated_at: string;
        };
        Insert: {
          user_id: string;
          preferred_styles?: string[];
          preferred_placements?: string[];
          updated_at?: string;
        };
        Update: {
          preferred_styles?: string[];
          preferred_placements?: string[];
          updated_at?: string;
        };
      };
    };
  };
}
