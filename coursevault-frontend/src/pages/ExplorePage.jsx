import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Bot, Microscope, Search, X } from 'lucide-react';
import CourseCard from '../components/course/CourseCard';
import { fetchAPI } from '../services/api';
import { sortCourses } from '../utils/courseOrder.js';
import { useAuth } from '../context/AuthContext.jsx';

export default function ExplorePage() {
  const navigate = useNavigate();
  // Read only, to decide where "back" goes: students came from Home, and the
  // Explore tab they would otherwise land on is hidden.
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const [courses, setCourses] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [rawQuery, setRawQuery] = useState('');

  // Read selected parent class from the URL instead of local state
  const selectedParentId = searchParams.get('class');

  useEffect(() => {
    fetchAPI('/courses')
      .then(data => {
        setCourses(data.courses || []);
        setIsLoading(false);
      })
      .catch(err => {
        console.error("Failed to load courses", err);
        setIsLoading(false);
      });
  }, []);

  // getClassNumber moved into utils/courseOrder.js as classNumber(), where the
  // shared comparator uses it. A second copy here would be a second rule.

  /*
   * Both lists use the shared comparator now.
   *
   * The classes were sorted by the number in the title, which ignored the
   * teacher's arrows entirely, and the subjects were not sorted at all — they
   * arrived in whatever order the server sent and stayed there. So "course
   * order is not reflecting inside class" was literally true: nothing on this
   * page had ever looked at display_order.
   */
  const topLevelCourses = sortCourses(courses.filter(c => !c.parent_course_id));

  const childCourses = selectedParentId
    ? sortCourses(courses.filter(c => c.parent_course_id === selectedParentId))
    : [];

  const selectedParentCourse = courses.find(c => c.id === selectedParentId);

  const query = rawQuery.trim().toLowerCase();

  const classTitleById = React.useMemo(() => {
    const map = new Map();
    for (const c of courses) if (!c.parent_course_id) map.set(c.id, c.title);
    return map;
  }, [courses]);

  /*
   * Search deliberately ignores the drill-down and looks at every course.
   *
   * Subjects live one level inside a class, so a search that only covered the
   * current view would fail to find "Thermodynamics" unless you had already
   * guessed which class it sat in — which is the thing you were searching to
   * avoid. Matching the parent class title too means "10th physics" finds the
   * Physics subject inside 10th Class.
   */
  const searchResults = React.useMemo(() => {
    if (!query) return [];

    const matches = courses.filter((c) => {
      const haystack = [
        c.title,
        c.description,
        c.parent_course_id ? classTitleById.get(c.parent_course_id) : '',
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });

    // Classes first — a class is the broader answer, and its subjects are one
    // click further in anyway.
    return matches.sort((a, b) => {
      const aIsClass = !a.parent_course_id;
      const bIsClass = !b.parent_course_id;
      if (aIsClass !== bIsClass) return aIsClass ? -1 : 1;
      return (a.title || '').localeCompare(b.title || '');
    });
  }, [courses, query, classTitleById]);

  return (
    <>
      <header className="relative pt-2 md:pt-10 pb-2 md:pb-20 text-center flex flex-col items-center justify-center">
        <div className="hidden md:block absolute top-0 left-10 text-black animate-float-icon">
          <Bot size={40} strokeWidth={1.5} />
        </div>
        <div className="hidden md:block absolute top-10 right-20 text-black animate-float-icon" style={{ animationDelay: '1s' }}>
          <Microscope size={40} strokeWidth={1.5} />
        </div>

        <h1 className="hidden md:block text-4xl md:text-7xl font-bold leading-[1.15] md:leading-[1.1] tracking-tight relative z-10 max-w-4xl">
          Educational content <br /> for curious minds.
        </h1>
      </header>

      <div className="pb-20">
        {/* Above the view switch so it stays put whether you are browsing all
            classes or already inside one. */}
        {!isLoading && courses.length > 0 && (
          <div className="relative mb-6 md:mb-8 max-w-xl">
            <Search
              size={18}
              strokeWidth={2.5}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
            />
            <input
              type="search"
              value={rawQuery}
              onChange={(e) => setRawQuery(e.target.value)}
              placeholder="Search classes and subjects..."
              aria-label="Search classes and subjects"
              className="w-full h-12 pl-10 pr-10 border-2 border-black rounded-xl bg-white font-medium shadow-[3px_3px_0px_0px_#111] focus:outline-none focus:ring-2 focus:ring-[#F26B4D]"
            />
            {rawQuery && (
              <button
                type="button"
                onClick={() => setRawQuery('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 flex items-center justify-center rounded-full border-2 border-black bg-white hover:bg-[#F26B4D] hover:text-white transition-colors"
              >
                <X size={13} strokeWidth={3} />
              </button>
            )}
          </div>
        )}

        {isLoading ? (
          <div className="text-center text-gray-500 font-bold py-10">Loading courses...</div>
        ) : courses.length === 0 ? (
          <div className="text-center text-gray-500 font-bold py-10">No courses published yet.</div>
        ) : query ? (
          /* =========================================
             SEARCH RESULTS — flat, across both levels
             ========================================= */
          <>
            <h2 className="text-2xl md:text-3xl font-black mb-4 md:mb-6">
              {searchResults.length === 0
                ? 'No matches'
                : `${searchResults.length} result${searchResults.length === 1 ? '' : 's'} for "${rawQuery.trim()}"`}
            </h2>

            {searchResults.length === 0 ? (
              <div className="bg-white border-2 border-dashed border-black rounded-xl p-10 text-center text-gray-500 font-bold shadow-[4px_4px_0px_0px_#111]">
                Nothing matched that. Try a class name, a subject, or part of a description.
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-3 md:gap-y-16 items-start">
                {searchResults.map((course, index) => {
                  const isClass = !course.parent_course_id;
                  return (
                    <div key={course.id}>
                      {/* Says what you are looking at — a bare grid of cards
                          gives no clue whether a hit is a class or a subject. */}
                      <div className="flex items-center gap-2 mb-1.5 text-[11px] font-black uppercase tracking-wider">
                        <span className={`px-2 py-0.5 border-2 border-black rounded-full ${isClass ? 'bg-[#F9E076]' : 'bg-[#A7E2D1]'}`}>
                          {isClass ? 'Class' : 'Subject'}
                        </span>
                        {!isClass && classTitleById.get(course.parent_course_id) && (
                          <span className="text-gray-500 truncate">
                            in {classTitleById.get(course.parent_course_id)}
                          </span>
                        )}
                      </div>
                      <CourseCard
                        course={course}
                        index={index}
                        isMyLearning={false}
                        onClick={() =>
                          isClass
                            ? (setRawQuery(''), setSearchParams({ class: course.id }))
                            : navigate(`/course/${course.id}`)
                        }
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <>
            {!selectedParentId ? (
              /* =========================================
                 VIEW 1: SHOW PARENT CATEGORIES ONLY
                 ========================================= */
              <>
                <h2 className="text-4xl font-bold tracking-tight mb-8">All Classes</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-3 md:gap-y-16 items-start animate-in fade-in zoom-in-95 duration-300">
                  {topLevelCourses.map((course, index) => (
                    <CourseCard 
                      key={course.id} 
                      course={course} 
                      index={index} 
                      isMyLearning={false}
                      onClick={() => setSearchParams({ class: course.id })} 
                    />
                  ))}
                </div>
              </>
            ) : (
              /* =========================================
                 VIEW 2: SHOW SUBJECTS INSIDE CATEGORY
                 ========================================= */
              <div className="animate-in slide-in-from-right-8 fade-in duration-300">

                {/* Navigation Header */}
                <div className="flex items-center gap-3 mb-4 md:mb-8">
                  {/*
                    Back goes home, not to the class list behind this view.

                    Students reach this page from a class card on the home
                    screen, and the Explore tab is hidden — so "All Classes"
                    would strand them on a page with no way onward that they
                    were never meant to be browsing. Home is where they came
                    from and where the classes are.

                    Educators, who have no home screen, keep the old behaviour.
                  */}
                  <button 
                    onClick={() => {
                      if (user?.role === 'educator' || user?.role === 'admin') setSearchParams({});
                      else navigate('/home');
                    }}
                    className="flex-shrink-0 flex items-center justify-center w-9 h-9 md:w-auto md:h-auto md:px-4 md:py-2 bg-white border-2 border-black rounded-full md:rounded-lg font-bold hover:bg-[#F9E076] transition-colors shadow-[2px_2px_0px_0px_#111]"
                  >
                    <span className="md:hidden text-lg leading-none">←</span>
                    <span className="hidden md:inline">
                      {user?.role === 'educator' || user?.role === 'admin'
                        ? '← Back to All Classes'
                        : '← Back to Home'}
                    </span>
                  </button>
                  {/*
                    The fallback matters now that the home screen links
                    straight here. A bookmark to a class that has since been
                    unpublished leaves selectedParentCourse undefined, and the
                    heading rendered as a lone " Subjects" with a dangling
                    space where the name should be.
                  */}
                  <h2 className="text-2xl md:text-3xl font-black">
                    {selectedParentCourse?.title
                      ? `${selectedParentCourse.title} Subjects`
                      : 'Subjects'}
                  </h2>
                </div>

                {/* The Subjects Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-3 md:gap-y-16 items-start">
                  {childCourses.length === 0 ? (
                    <div className="col-span-full bg-white border-2 border-dashed border-black rounded-xl p-12 text-center text-gray-500 font-bold text-lg shadow-[4px_4px_0px_0px_#111]">
                      {selectedParentCourse
                        ? 'No subjects published in this class yet.'
                        : 'That class is no longer available.'}
                    </div>
                  ) : (
                    childCourses.map((child, i) => (
                      <CourseCard
                        key={child.id}
                        course={child}
                        index={i}
                        isMyLearning={false}
                        onClick={(id) => navigate(`/course/${id}`)}
                      />
                    ))
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}