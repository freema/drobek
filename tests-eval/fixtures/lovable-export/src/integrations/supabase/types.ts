export type Database = {
  public: {
    Tables: {
      messages: {
        Row: { id: string; name: string; message: string; created_at: string };
        Insert: { id?: string; name: string; message: string; created_at?: string };
        Update: { id?: string; name?: string; message?: string; created_at?: string };
        Relationships: [];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
