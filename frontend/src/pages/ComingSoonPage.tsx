type ComingSoonPageProps = {
  title: string;
};

function ComingSoonPage({ title }: ComingSoonPageProps) {
  return (
    <div className="anime-panel rounded-3xl p-10">
      <div className="flex min-h-[55vh] items-center justify-center">
        <div className="text-center">
          <h2 className="mb-4 text-2xl font-semibold text-zinc-100">{title}</h2>
          <p className="animate-pulse bg-gradient-to-r from-fuchsia-200 via-sky-200 to-indigo-200 bg-clip-text text-3xl font-semibold tracking-tight text-transparent">
            Coming soon ...
          </p>
        </div>
      </div>
    </div>
  );
}

export default ComingSoonPage;
