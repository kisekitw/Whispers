import React, { useEffect, useState } from "react";
import { 
  Users, 
  GraduationCap, 
  UserRound, 
  Activity, 
  CreditCard, 
  MessageSquare,
  ChevronRight,
  ChevronDown,
  TrendingUp,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  Terminal
} from "lucide-react";
import { 
  PieChart, 
  Pie, 
  Cell, 
  ResponsiveContainer, 
  Tooltip, 
  BarChart, 
  Bar, 
  XAxis, 
  YAxis, 
  CartesianGrid 
} from "recharts";
import { cn } from "../lib/utils";

interface Stats {
  totalUsers: number;
  teachers: number;
  parents: number;
  recentLogs: any[];
}

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [expandedLogIndex, setExpandedLogIndex] = useState<number | null>(null);

  const fetchStats = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    try {
      const res = await fetch("/api/stats");
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.error("Error fetching stats:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchStats();
  }, []);

  const createTestLog = async () => {
    try {
      await fetch("/api/debug/create-test-log", { method: "POST" });
      fetchStats(true);
    } catch (e) {
      alert("建立測試日誌失敗");
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-[#F5F5F0]">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-[#5A5A40]"></div>
      </div>
    );
  }

  const chartData = [
    { name: "老師", value: stats?.teachers || 0, color: "#5A5A40" },
    { name: "家長", value: stats?.parents || 0, color: "#A3A375" },
  ];

  const StatCard = ({ title, value, icon: Icon, color }: any) => (
    <div className="bg-white p-6 rounded-[32px] shadow-sm border border-black/5 flex items-center gap-4">
      <div className={cn("p-3 rounded-2xl", color)}>
        <Icon className="w-6 h-6 text-white" />
      </div>
      <div>
        <p className="text-sm font-medium text-gray-500 uppercase tracking-wider">{title}</p>
        <p className="text-2xl font-semibold text-gray-900">{value}</p>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#F5F5F0] p-8 font-serif">
      <div className="max-w-7xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex justify-between items-end">
          <div>
            <h1 className="text-4xl font-light text-[#1A1A1A] mb-2">親師悄悄話 管理後台</h1>
            <p className="text-[#5A5A40] italic">即時監控親師溝通助手數據</p>
          </div>
          <div className="flex items-center gap-4">
            <button 
              onClick={() => fetchStats(true)}
              disabled={refreshing}
              className={cn(
                "p-3 rounded-full bg-white shadow-sm border border-black/5 hover:bg-gray-50 transition-all",
                refreshing && "animate-spin"
              )}
              title="重新整理"
            >
              <RefreshCw className="w-5 h-5 text-[#5A5A40]" />
            </button>
            <div className="text-right">
              <p className="text-sm text-gray-500">最後更新：{new Date().toLocaleTimeString()}</p>
            </div>
          </div>
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <StatCard title="總用戶數" value={stats?.totalUsers || 0} icon={Users} color="bg-[#5A5A40]" />
          <StatCard title="老師用戶" value={stats?.teachers || 0} icon={GraduationCap} color="bg-[#7A7A5C]" />
          <StatCard title="家長用戶" value={stats?.parents || 0} icon={UserRound} color="bg-[#A3A375]" />
          <StatCard title="今日活躍" value={stats?.recentLogs?.length || 0} icon={Activity} color="bg-[#C2C299]" />
        </div>

        {/* Charts Section */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* User Distribution */}
          <div className="bg-white p-8 rounded-[32px] shadow-sm border border-black/5 lg:col-span-1">
            <h3 className="text-xl font-medium mb-6 flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-[#5A5A40]" />
              用戶分佈
            </h3>
            <div className="h-[300px] w-full min-h-[300px]">
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={chartData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={80}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {chartData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ borderRadius: '16px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-center gap-8 mt-4">
              {chartData.map((item) => (
                <div key={item.name} className="flex items-center gap-2">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: item.color }} />
                  <span className="text-sm text-gray-600">{item.name}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Recent Activity */}
          <div className="bg-white p-8 rounded-[32px] shadow-sm border border-black/5 lg:col-span-2">
            <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-medium flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-[#5A5A40]" />
                最近使用日誌
              </h3>
              <button 
                onClick={createTestLog}
                className="text-[10px] uppercase tracking-widest text-gray-400 hover:text-[#5A5A40] flex items-center gap-1"
              >
                <Terminal className="w-3 h-3" />
                產生測試日誌
              </button>
            </div>
            <div className="space-y-4">
              {(!stats?.recentLogs || stats.recentLogs.length === 0) ? (
                <div className="text-center py-12 space-y-2">
                  <p className="text-gray-400 italic">尚無使用記錄</p>
                  <p className="text-xs text-gray-300">提示：在 LINE 傳送訊息觸發 AI 生成後，日誌將會出現在此。</p>
                </div>
              ) : (
                stats.recentLogs.map((log, i) => {
                  const isExpanded = expandedLogIndex === i;
                  return (
                    <div key={i} className="border border-black/5 rounded-2xl overflow-hidden transition-all duration-200">
                      <button 
                        onClick={() => setExpandedLogIndex(isExpanded ? null : i)}
                        className={cn(
                          "w-full flex items-center justify-between p-4 hover:bg-[#F5F5F0] transition-colors group text-left",
                          isExpanded && "bg-[#F5F5F0]"
                        )}
                      >
                        <div className="flex items-center gap-4">
                          <div className={cn(
                            "w-10 h-10 rounded-full flex items-center justify-center relative",
                            log.userType === "teacher" ? "bg-[#5A5A40]/10 text-[#5A5A40]" : "bg-[#A3A375]/10 text-[#A3A375]"
                          )}>
                            {log.userType === "teacher" ? <GraduationCap className="w-5 h-5" /> : <UserRound className="w-5 h-5" />}
                            {log.status === "error" && (
                              <div className="absolute -top-1 -right-1 bg-red-500 rounded-full p-0.5 border-2 border-white">
                                <AlertCircle className="w-2 h-2 text-white" />
                              </div>
                            )}
                          </div>
                          <div>
                            <p className="font-medium text-gray-900 flex items-center gap-2">
                              {log.action}
                              {log.status === "success" ? (
                                <CheckCircle2 className="w-3 h-3 text-green-500" />
                              ) : (
                                <AlertCircle className="w-3 h-3 text-red-500" />
                              )}
                            </p>
                            <p className="text-xs text-gray-500">{new Date(log.timestamp).toLocaleString()}</p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 text-gray-400 group-hover:text-[#5A5A40]">
                          <span className="text-xs uppercase tracking-widest">{log.userType}</span>
                          {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                        </div>
                      </button>
                      
                      {isExpanded && (
                        <div className="p-6 bg-white border-t border-black/5 space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                              <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest">輸入內容 (Input)</h4>
                              <div className="bg-[#F5F5F0] p-4 rounded-xl text-sm font-mono overflow-x-auto max-h-[200px] whitespace-pre-wrap">
                                {(() => {
                                  try {
                                    const parsed = JSON.parse(log.input);
                                    return JSON.stringify(parsed, null, 2);
                                  } catch (e) {
                                    return log.input;
                                  }
                                })()}
                              </div>
                            </div>
                            <div className="space-y-2">
                              <h4 className="text-xs font-bold text-gray-400 uppercase tracking-widest">
                                {log.status === "error" ? "錯誤訊息 (Error)" : "輸出內容 (Output)"}
                              </h4>
                              <div className={cn(
                                "p-4 rounded-xl text-sm font-mono overflow-x-auto max-h-[200px] whitespace-pre-wrap",
                                log.status === "error" ? "bg-red-50 text-red-600 border border-red-100" : "bg-[#F5F5F0]"
                              )}>
                                {log.status === "error" ? log.error : log.output}
                              </div>
                            </div>
                          </div>
                          <div className="flex justify-between items-center pt-4 border-t border-black/5 text-[10px] text-gray-400 uppercase tracking-widest">
                            <span>
                              {log.displayName && <span className="text-gray-600 normal-case mr-2">{log.displayName}</span>}
                              User ID: {log.userId}
                            </span>
                            <span>Model: {log.model || "N/A"}</span>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Footer Info */}
        <div className="bg-[#5A5A40] text-white p-8 rounded-[32px] flex flex-col md:flex-row justify-between items-center gap-6">
          <div>
            <h4 className="text-2xl font-light mb-2">LINE Bot 串接狀態</h4>
            <p className="opacity-80">Webhook URL: {window.location.origin}/api/webhook</p>
          </div>
          <button 
            className="bg-white text-[#5A5A40] px-8 py-3 rounded-full font-medium hover:bg-opacity-90 transition-all"
            onClick={() => window.open('https://developers.line.biz/zh-hant/', '_blank')}
          >
            前往 LINE Developer
          </button>
        </div>
      </div>
    </div>
  );
}
